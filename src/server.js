'use strict'

/**
 * Web layer: static dashboard + REST API + WebSocket bridge.
 *
 * Security model
 *  • reading the chat is public (that is the point of the site)
 *  • writing (chat / commands / server switch) needs CHAT_TOKEN unless
 *    ALLOW_ANONYMOUS_CHAT=true
 *  • cross-site requests are blocked unless the Origin is in ALLOWED_ORIGINS
 *  • outgoing chat is rate limited per client and queued by the bot
 */

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')

const PKG = require('../package.json')

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a ?? ''))
  const bb = Buffer.from(String(b ?? ''))
  if (!ba.length || ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function originOf (req) {
  const raw = req.headers?.origin || (req.origin ?? null)
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.origin
  } catch {
    return null
  }
}

/** Same-origin, or explicitly listed in ALLOWED_ORIGINS. */
function isAllowedOrigin (req, config) {
  const origin = originOf(req)
  if (!origin) return true // curl / native clients send no Origin
  if (config.web.allowedOrigins.includes('*')) return true
  if (config.web.allowedOrigins.includes(origin)) return true
  const host = (req.headers?.host || '').split(':')[0]
  try {
    return new URL(origin).hostname === host // served by this very process
  } catch {
    return false
  }
}

class RateLimiter {
  constructor ({ messages = 8, windowMs = 10000 } = {}) {
    this.messages = messages
    this.windowMs = windowMs
    this.hits = new Map()
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [key, arr] of this.hits) {
        const kept = arr.filter((t) => now - t < windowMs)
        if (kept.length) this.hits.set(key, kept)
        else this.hits.delete(key)
      }
    }, windowMs)
    timer.unref?.()
  }

  check (key) {
    const now = Date.now()
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    if (arr.length >= this.messages) {
      this.hits.set(key, arr)
      return { ok: false, retryMs: this.windowMs - (now - arr[0]) }
    }
    arr.push(now)
    this.hits.set(key, arr)
    return { ok: true, remaining: this.messages - arr.length }
  }
}

function createServer ({ store, bot, config, log = console.log }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '16kb' }))

  const limiter = new RateLimiter(config.web.rateLimit)
  const sockets = new Set()
  let wss = null

  /* ─────────────────────────────── helpers ────────────────────────────── */

  const clientKey = (req) => (req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown')

  function authorized (req) {
    if (config.web.anonymousChat) return true
    const token =
      req.body?.token ||
      req.query?.token ||
      String(req.headers['x-chat-token'] || '') ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    return safeEqual(token, config.web.chatToken)
  }

  function publicState () {
    const s = store.getState()
    return {
      phase: s.phase,
      online: s.online,
      username: s.username,
      auth: s.auth,
      version: s.version,
      server: s.server,
      servers: s.servers,
      connectedAt: s.connectedAt,
      startedAt: s.startedAt,
      uptimeMs: s.uptimeMs,
      runtimeMs: s.runtimeMs,
      attempts: s.attempts,
      lastError: s.lastError,
      lastErrorHint: s.lastErrorHint,
      lastKick: s.lastKick,
      health: s.health,
      food: s.food,
      position: s.position,
      dimension: s.dimension,
      time: s.time,
      players: s.players,
      playerCount: s.playerCount,
      maxPlayers: s.maxPlayers,
      serverInfo: s.serverInfo,
      counters: s.counters,
      buffered: s.buffered
    }
  }

  const deny = (res, code, message, status = 403) => res.status(status).json({ ok: false, code, error: message })

  /* ──────────────────────────────── routes ────────────────────────────── */

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, phase: store.state.phase, online: store.state.online, version: PKG.version })
  })

  app.get('/api/config', (req, res) => {
    res.json({
      ok: true,
      bot: { username: config.bot.username, auth: config.bot.auth },
      servers: config.bot.servers.map((s) => ({ host: s.host, port: s.port, label: s.label })),
      allowServerSwitch: config.web.allowServerSwitch,
      anonymousChat: config.web.anonymousChat,
      tokenRequired: !config.web.anonymousChat,
      showActionBar: config.web.showActionBar,
      rateLimit: config.web.rateLimit,
      version: PKG.version
    })
  })

  // Used by the dashboard's "Test token" button. Never reveals the token itself.
  app.all('/api/verify', (req, res) => {
    if (!isAllowedOrigin(req, config)) return deny(res, 'bad_origin', 'Origin not allowed.', 403)
    const token =
      req.query?.token ||
      req.body?.token ||
      String(req.headers['x-chat-token'] || '') ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const authorized = config.web.anonymousChat || safeEqual(token, config.web.chatToken)
    res.json({ ok: true, authorized, anonymous: config.web.anonymousChat })
  })

  app.get('/api/state', (req, res) => res.json({ ok: true, state: publicState() }))

  app.get('/api/messages', (req, res) => {
    const since = Number.parseInt(req.query.since || '0', 10) || 0
    const limit = Math.min(1000, Number.parseInt(req.query.limit || '200', 10) || 200)
    res.json({ ok: true, lastId: store.lastId(), messages: store.since(since, limit) })
  })

  app.post('/api/chat', async (req, res) => {
    if (!isAllowedOrigin(req, config)) return deny(res, 'bad_origin', 'Origin not allowed.', 403)
    if (!authorized(req)) return deny(res, 'unauthorized', 'Missing or wrong chat token.', 401)
    const text = String(req.body?.text ?? '').slice(0, 500)
    if (!text.trim()) return deny(res, 'empty', 'Nothing to send.', 400)

    const rl = limiter.check(clientKey(req))
    if (!rl.ok) {
      res.set('Retry-After', String(Math.ceil(rl.retryMs / 1000)))
      return deny(res, 'rate_limited', `Too fast — try again in ${Math.ceil(rl.retryMs / 1000)}s.`, 429)
    }

    const result = await bot.sendChat(text, { source: 'web', ip: clientKey(req) })
    if (!result.ok) return deny(res, 'send_failed', result.error, 409)
    res.json({ ok: true })
  })

  app.post('/api/action', async (req, res) => {
    if (!isAllowedOrigin(req, config)) return deny(res, 'bad_origin', 'Origin not allowed.', 403)
    if (!authorized(req)) return deny(res, 'unauthorized', 'Missing or wrong chat token.', 401)
    const action = String(req.body?.action ?? '')
    const result = await bot.action(action)
    if (!result.ok) return deny(res, 'action_failed', result.error, 409)
    res.json({ ok: true })
  })

  app.post('/api/server', async (req, res) => {
    if (!isAllowedOrigin(req, config)) return deny(res, 'bad_origin', 'Origin not allowed.', 403)
    if (!authorized(req)) return deny(res, 'unauthorized', 'Missing or wrong chat token.', 401)
    if (!config.web.allowServerSwitch) return deny(res, 'forbidden', 'Server switching is disabled (ALLOW_SERVER_SWITCH).', 403)
    const label = String(req.body?.label ?? '')
    const result = await bot.switchServer(label)
    if (!result.ok) return deny(res, 'switch_failed', result.error, 409)
    res.json({ ok: true, server: result.server })
  })

  app.post('/api/clear', (req, res) => {
    if (!isAllowedOrigin(req, config)) return deny(res, 'bad_origin', 'Origin not allowed.', 403)
    if (!authorized(req)) return deny(res, 'unauthorized', 'Missing or wrong chat token.', 401)
    store.clear()
    broadcast({ type: 'cleared' })
    res.json({ ok: true })
  })

  // Static dashboard (also usable standalone from GitHub Pages / Cloudflare Pages)
  app.use(
    express.static(config.web.publicDir, {
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
      }
    })
  )

  const notFoundPage = path.join(config.web.publicDir, '404.html')
  const hasNotFoundPage = fs.existsSync(notFoundPage)

  app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
      return res.status(404).json({ ok: false, error: 'Not found' })
    }
    if (hasNotFoundPage) return res.status(404).type('html').sendFile(notFoundPage)
    res.status(404).send('Not found')
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log('[web] error:', err?.message || err)
    if (res.headersSent) return
    res.status(500).json({ ok: false, error: 'Internal error' })
  })

  /* ────────────────────────────── websocket ───────────────────────────── */

  function broadcast (payload) {
    const data = JSON.stringify(payload)
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        try {
          ws.send(data)
        } catch {
          /* socket died; the heartbeat will reap it */
        }
      }
    }
  }

  function send (ws, payload) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      /* noop */
    }
  }

  const onMessage = (message) => broadcast({ type: 'message', message, counters: { ...store.counters } })
  const onState = (state) => broadcast({ type: 'state', state: publicState() })
  const onCleared = () => broadcast({ type: 'cleared' })

  store.on('message', onMessage)
  store.on('state', onState)
  store.on('cleared', onCleared)

  /**
   * @param {import('http').Server} httpServer
   */
  function attachWebSocket (httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 8 * 1024 })

    wss.on('connection', (ws, req) => {
      const key = clientKey(req)
      ws.isAlive = true
      ws.authed = config.web.anonymousChat
      ws.key = key

      if (!isAllowedOrigin(req, config)) {
        send(ws, { type: 'error', code: 'bad_origin', message: 'Origin not allowed.' })
        return ws.close(4003, 'bad origin')
      }

      const url = new URL(req.url, 'http://localhost')
      const helloToken = url.searchParams.get('token')
      if (helloToken && safeEqual(helloToken, config.web.chatToken)) ws.authed = true

      sockets.add(ws)
      log(`[web] websocket connected (${key}) — ${sockets.size} online`)

      send(ws, {
        type: 'hello',
        state: publicState(),
        messages: store.since(0, store.historySize),
        lastId: store.lastId(),
        you: { authenticated: ws.authed, anonymousChat: config.web.anonymousChat }
      })

      ws.on('pong', () => {
        ws.isAlive = true
      })

      ws.on('message', async (raw) => {
        ws.isAlive = true
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return send(ws, { type: 'error', code: 'bad_json', message: 'Expected JSON.' })
        }
        if (!msg || typeof msg !== 'object') return

        const clientMsgId = msg.id ?? null

        switch (msg.type) {
          case 'ping':
            return send(ws, { type: 'pong', t: Date.now(), id: clientMsgId })

          case 'auth': {
            ws.authed = config.web.anonymousChat || safeEqual(msg.token, config.web.chatToken)
            return send(ws, {
              type: 'auth',
              id: clientMsgId,
              ok: ws.authed,
              message: ws.authed ? null : 'Wrong token.'
            })
          }

          case 'chat': {
            if (!ws.authed) {
              return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: 'Send your token first (type: "auth").' })
            }
            const text = String(msg.text ?? '').slice(0, 500)
            if (!text.trim()) return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: 'Empty message.' })
            const rl = limiter.check(ws.key)
            if (!rl.ok) {
              return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: `Too fast — wait ${Math.ceil(rl.retryMs / 1000)}s.` })
            }
            const result = await bot.sendChat(text, { source: 'web', ip: ws.key })
            return send(ws, { type: 'ack', id: clientMsgId, ok: result.ok, error: result.ok ? null : result.error })
          }

          case 'action': {
            if (!ws.authed) return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: 'Not authorized.' })
            const result = await bot.action(String(msg.action ?? ''))
            return send(ws, { type: 'ack', id: clientMsgId, ok: result.ok, error: result.ok ? null : result.error })
          }

          case 'switch': {
            if (!ws.authed) return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: 'Not authorized.' })
            if (!config.web.allowServerSwitch) {
              return send(ws, { type: 'ack', id: clientMsgId, ok: false, error: 'Server switching is disabled.' })
            }
            const result = await bot.switchServer(String(msg.label ?? ''))
            return send(ws, { type: 'ack', id: clientMsgId, ok: result.ok, error: result.ok ? null : result.error })
          }

          case 'sync': {
            const since = Number.parseInt(msg.since || '0', 10) || 0
            return send(ws, { type: 'sync', id: clientMsgId, messages: store.since(since), lastId: store.lastId() })
          }

          default:
            return send(ws, { type: 'error', code: 'unknown_type', message: `Unknown type "${msg.type}".` })
        }
      })

      const cleanup = () => {
        sockets.delete(ws)
        log(`[web] websocket closed (${key}) — ${sockets.size} online`)
      }
      ws.on('close', cleanup)
      ws.on('error', cleanup)
    })

    // Reap dead sockets so we never leak file descriptors.
    const heartbeat = setInterval(() => {
      for (const ws of sockets) {
        if (!ws.isAlive) {
          try {
            ws.terminate()
          } catch {
            /* noop */
          }
          sockets.delete(ws)
          continue
        }
        ws.isAlive = false
        try {
          ws.ping()
        } catch {
          /* noop */
        }
      }
    }, 30000)
    heartbeat.unref?.()

    wss.on('close', () => clearInterval(heartbeat))
    return wss
  }

  function close () {
    store.off('message', onMessage)
    store.off('state', onState)
    store.off('cleared', onCleared)
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* noop */
      }
    }
    sockets.clear()
    if (wss) wss.close()
  }

  return { app, attachWebSocket, broadcast, close, limiter }
}

module.exports = { createServer, RateLimiter, safeEqual, isAllowedOrigin }
