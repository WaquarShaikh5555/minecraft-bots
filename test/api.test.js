'use strict'

/**
 * End-to-end test of the web layer: REST API + WebSocket bridge.
 * The Minecraft bot is replaced by a stub so no server is needed.
 */

// Must be set before src/config is required: it makes config ignore any local
// .env so a developer's sandbox settings cannot change test expectations.
process.env.NODE_ENV = 'test'
process.env.CHAT_TOKEN = 'test-token-0123456789abcdef'
process.env.ALLOW_ANONYMOUS_CHAT = 'false'
process.env.ALLOW_SERVER_SWITCH = 'false'
process.env.PORT = '0'
process.env.NO_BOT = 'true'
process.env.PING_SERVER = 'false'
process.env.RATE_LIMIT_MESSAGES = '100'
process.env.CHAT_LOG_FILE = 'false'
process.env.MC_SERVERS = 'alpha.test:25565,beta.test'
process.env.MC_USERNAME = 'waquar5555'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { config } = require('../src/config')
const { Store } = require('../src/store')
const { createServer, RateLimiter } = require('../src/server')

config.web.logFile = null

function stubBot (store) {
  return {
    sent: [],
    actions: [],
    switches: [],
    async start () {
      store.setState({ phase: 'online', online: true, username: config.bot.username, server: config.bot.servers[0] })
      return true
    },
    async stop () {
      store.setState({ phase: 'stopped', online: false })
    },
    async sendChat (text) {
      if (!text || !text.trim()) return { ok: false, error: 'Empty message.' }
      this.sent.push(text)
      store.push({ kind: 'bot', author: config.bot.username, text, meta: { source: 'web' } })
      return { ok: true }
    },
    async action (name) {
      this.actions.push(name)
      return name ? { ok: true } : { ok: false, error: 'Unknown action.' }
    },
    async switchServer (label) {
      this.switches.push(label)
      const server = config.bot.servers.find((s) => s.label === label)
      return server ? { ok: true, server: server.label } : { ok: false, error: 'Unknown server.' }
    }
  }
}

async function boot () {
  const store = new Store({ historySize: 50, logFile: null })
  const bot = stubBot(store)
  await bot.start()
  const web = createServer({ store, bot, config, log: () => {} })
  const server = http.createServer(web.app)
  web.attachWebSocket(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    store,
    bot,
    web,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        web.close()
        server.close(() => resolve())
      })
  }
}

const json = (res) => res.json()

function openSocket (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('socket timeout')), 4000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(timer)
      reject(e.error || e)
    })
  })
}

/** Collect messages until one satisfies `pred` (or timeout). */
function waitFor (ws, pred, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      reject(new Error('timed out waiting for websocket message'))
    }, timeout)
    const onMsg = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (pred(msg)) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        resolve(msg)
      }
    }
    ws.addEventListener('message', onMsg)
  })
}

test('GET /healthz and /api/config', async (t) => {
  const app = await boot()
  t.after(app.close)

  const health = await json(await fetch(`${app.base}/healthz`))
  assert.equal(health.ok, true)
  assert.equal(health.phase, 'online')

  const cfg = await json(await fetch(`${app.base}/api/config`))
  assert.equal(cfg.tokenRequired, true)
  assert.equal(cfg.bot.username, 'waquar5555')
  assert.equal(cfg.servers.length, 2)
  assert.equal(cfg.anonymousChat, false)
})

test('GET /api/state exposes bot vitals but no secrets', async (t) => {
  const app = await boot()
  t.after(app.close)
  app.store.setState({ health: 20, food: 18, position: { x: 1, y: 2, z: 3 } })
  const { state } = await json(await fetch(`${app.base}/api/state`))
  assert.equal(state.phase, 'online')
  assert.equal(state.health, 20)
  assert.deepEqual(state.position, { x: 1, y: 2, z: 3 })
  assert.equal(state.chatToken, undefined)
  assert.equal(JSON.stringify(state).includes(config.web.chatToken), false)
})

test('POST /api/chat requires a valid token', async (t) => {
  const app = await boot()
  t.after(app.close)

  const noToken = await fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' })
  })
  assert.equal(noToken.status, 401)

  const badToken = await fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi', token: 'wrong' })
  })
  assert.equal(badToken.status, 401)

  const ok = await json(
    await fetch(`${app.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello server', token: config.web.chatToken })
    })
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(app.bot.sent, ['hello server'])
})

test('POST /api/chat rejects empty messages and bad origins', async (t) => {
  const app = await boot()
  t.after(app.close)

  const empty = await fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ', token: config.web.chatToken })
  })
  assert.equal(empty.status, 400)

  const evil = await fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'spam', token: config.web.chatToken })
  })
  assert.equal(evil.status, 403)
  assert.deepEqual(app.bot.sent, [])
})

test('/api/verify answers without leaking the token', async (t) => {
  const app = await boot()
  t.after(app.close)

  const good = await json(await fetch(`${app.base}/api/verify?token=${config.web.chatToken}`))
  assert.deepEqual(good, { ok: true, authorized: true, anonymous: false })

  const bad = await json(await fetch(`${app.base}/api/verify?token=nope`))
  assert.equal(bad.authorized, false)
})

test('GET /api/messages supports incremental sync', async (t) => {
  const app = await boot()
  t.after(app.close)

  app.store.push({ kind: 'chat', author: 'Alex', text: 'one' })
  const first = await json(await fetch(`${app.base}/api/messages`))
  assert.ok(first.messages.some((m) => m.text === 'one'))
  const sinceId = first.lastId

  app.store.push({ kind: 'chat', author: 'Steve', text: 'two' })
  const next = await json(await fetch(`${app.base}/api/messages?since=${sinceId}`))
  assert.equal(next.messages.length, 1)
  assert.equal(next.messages[0].text, 'two')
})

test('actions and server switching are gated', async (t) => {
  const app = await boot()
  t.after(app.close)

  const unauth = await fetch(`${app.base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reconnect' })
  })
  assert.equal(unauth.status, 401)

  const ok = await json(
    await fetch(`${app.base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reconnect', token: config.web.chatToken })
    })
  )
  assert.equal(ok.ok, true)
  assert.deepEqual(app.bot.actions, ['reconnect'])

  // ALLOW_SERVER_SWITCH is false by default
  const blocked = await fetch(`${app.base}/api/server`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'beta.test', token: config.web.chatToken })
  })
  assert.equal(blocked.status, 403)
  assert.deepEqual(app.bot.switches, [])
})

test('static dashboard is served', async (t) => {
  const app = await boot()
  t.after(app.close)
  const res = await fetch(`${app.base}/`)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /id="feed"/)
  assert.equal((await fetch(`${app.base}/styles.css`)).status, 200)
  assert.equal((await fetch(`${app.base}/app.js`)).status, 200)
  assert.equal((await fetch(`${app.base}/nope`)).status, 404)
})

test('websocket: hello replays history and streams new lines', async (t) => {
  const app = await boot()
  t.after(app.close)
  app.store.push({ kind: 'chat', author: 'Alex', text: 'before connect' })

  const ws = await openSocket(`${app.wsBase}/ws?token=${encodeURIComponent(config.web.chatToken)}`)
  t.after(() => ws.close())

  const hello = await waitFor(ws, (m) => m.type === 'hello')
  assert.equal(hello.you.authenticated, true)
  assert.equal(hello.state.phase, 'online')
  assert.ok(hello.messages.some((m) => m.text === 'before connect'))

  // A line produced by the bot is broadcast to viewers.
  const incoming = waitFor(ws, (m) => m.type === 'message')
  app.store.push({ kind: 'chat', author: 'Steve_', text: 'live line' })
  const broadcast = await incoming
  assert.equal(broadcast.message.text, 'live line')
  assert.equal(broadcast.message.author, 'Steve_')
})

test('websocket: chat round-trip returns an ack', async (t) => {
  const app = await boot()
  t.after(app.close)

  const ws = await openSocket(`${app.wsBase}/ws?token=${encodeURIComponent(config.web.chatToken)}`)
  t.after(() => ws.close())
  await waitFor(ws, (m) => m.type === 'hello')

  const ack = waitFor(ws, (m) => m.type === 'ack' && m.id === 'x1')
  ws.send(JSON.stringify({ type: 'chat', text: 'from the browser', id: 'x1' }))
  const result = await ack
  assert.equal(result.ok, true)
  assert.deepEqual(app.bot.sent, ['from the browser'])
})

test('websocket: unauthenticated clients cannot send', async (t) => {
  const app = await boot()
  t.after(app.close)

  const ws = await openSocket(`${app.wsBase}/ws`)
  t.after(() => ws.close())
  const hello = await waitFor(ws, (m) => m.type === 'hello')
  assert.equal(hello.you.authenticated, false)

  const ack = waitFor(ws, (m) => m.type === 'ack')
  ws.send(JSON.stringify({ type: 'chat', text: 'sneaky', id: 'y1' }))
  const res = await ack
  assert.equal(res.ok, false)
  assert.match(res.error, /token/i)
  assert.deepEqual(app.bot.sent, [])

  // ...but they can authenticate mid-session.
  const authAck = waitFor(ws, (m) => m.type === 'auth')
  ws.send(JSON.stringify({ type: 'auth', token: config.web.chatToken }))
  assert.equal((await authAck).ok, true)

  const ack2 = waitFor(ws, (m) => m.type === 'ack' && m.id === 'y2')
  ws.send(JSON.stringify({ type: 'chat', text: 'now allowed', id: 'y2' }))
  assert.equal((await ack2).ok, true)
})

test('websocket: foreign origins are rejected', async (t) => {
  const app = await boot()
  t.after(app.close)
  const ws = new WebSocket(`${app.wsBase}/ws`, { headers: { Origin: 'https://evil.example' } })
  const closed = await new Promise((resolve) => {
    ws.addEventListener('close', (ev) => resolve(ev.code))
    ws.addEventListener('error', () => resolve('error'))
    setTimeout(() => resolve('timeout'), 3000)
  })
  assert.equal(closed, 4003)
})

test('websocket: sync catches a client up after a gap', async (t) => {
  const app = await boot()
  t.after(app.close)
  const ws = await openSocket(`${app.wsBase}/ws`)
  t.after(() => ws.close())
  const hello = await waitFor(ws, (m) => m.type === 'hello')

  app.store.push({ kind: 'chat', text: 'missed line' })
  const sync = waitFor(ws, (m) => m.type === 'sync')
  ws.send(JSON.stringify({ type: 'sync', since: hello.lastId, id: 'z1' }))
  const res = await sync
  assert.ok(res.messages.some((m) => m.text === 'missed line'))
})

test('RateLimiter blocks after the configured burst', () => {
  const limiter = new RateLimiter({ messages: 3, windowMs: 60000 })
  assert.equal(limiter.check('ip1').ok, true)
  assert.equal(limiter.check('ip1').ok, true)
  assert.equal(limiter.check('ip1').ok, true)
  const blocked = limiter.check('ip1')
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryMs > 0)
  // a different client is unaffected
  assert.equal(limiter.check('ip2').ok, true)
})
