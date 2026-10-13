'use strict'

/**
 * BotManager — owns exactly one Mineflayer bot at a time.
 *
 * Responsibilities
 *  • connect / reconnect with exponential backoff
 *  • forward every chat, system and status line into the Store
 *  • keep the live state (health, position, players, server MOTD) up to date
 *  • expose a queued, rate-limited `sendChat()` used by the web dashboard
 *  • explain common failures (online-mode server, version mismatch, DNS, ...)
 */

const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const mc = require('minecraft-protocol')

const { parseSpeaker, plain, motd, stripColors, explainFailure, formatPosition, componentText } = require('./text')

const PING_TIMEOUT = 6000

class BotManager extends EventEmitter {
  /**
   * @param {import('./store').Store} store
   * @param {object} config  the `config` object from src/config.js
   * @param {(level:string, ...args:any[])=>void} [log]
   */
  constructor (store, config, log = console.log) {
    super()
    this.store = store
    this.config = config
    this.log = log

    this.bot = null
    this.target = null // { host, port, label }
    this.stopping = false
    this.attempts = 0
    this.reconnectTimer = null
    this.playerListTimer = null
    this.lastSendAt = 0
    this.queue = []
    this.drainTimer = null
    /** normalised text -> timestamp, used to hide the server's echo of our own chat */
    this.recentlySent = new Map()
    /** status text -> timestamp, used to collapse duplicate error lines */
    this._statusSeen = new Map()

    store.setState({
      username: config.bot.username,
      servers: config.bot.servers,
      auth: config.bot.auth,
      phase: 'idle'
    })
  }

  /* ───────────────────────────── connection ───────────────────────────── */

  findServer (labelOrHost) {
    const servers = this.config.bot.servers
    if (!labelOrHost) return servers[0] || null
    const want = String(labelOrHost).trim().toLowerCase()
    return (
      servers.find((s) => s.label.toLowerCase() === want) ||
      servers.find((s) => s.host.toLowerCase() === want || `${s.host}:${s.port}` === want) ||
      null
    )
  }

  async start (target) {
    this.stopping = false
    this.attempts = 0
    return this.connect(target)
  }

  /** Connect (or reconnect) to a server from the configured list. */
  connect (target) {
    const server = typeof target === 'string' ? this.findServer(target) : target || this.target || this.config.bot.servers[0]
    if (!server) {
      this.store.setState({ phase: 'error', lastError: 'No servers configured (MC_SERVERS is empty).' })
      return Promise.resolve(false)
    }

    this.teardownBot('switching servers')
    this.target = server
    this.store.setState({
      phase: 'connecting',
      server,
      lastError: null,
      lastErrorHint: null,
      online: false,
      connectedAt: null,
      attempts: this.attempts,
      players: [],
      playerCount: 0
    })
    this.pushStatus(`Connecting to ${server.label} as ${this.config.bot.username} (${this.config.bot.auth} mode)…`)
    this.refreshServerInfo(server)

    let bot
    try {
      bot = mineflayer.createBot({
        host: server.host,
        port: server.port,
        username: this.config.bot.username,
        auth: this.config.bot.auth,
        version: this.config.bot.version || false,
        viewDistance: this.config.bot.viewDistance,
        hideErrors: this.config.bot.hideErrors,
        logErrors: false,
        respawn: this.config.bot.respawn,
        checkTimeoutInterval: this.config.bot.checkTimeoutInterval,
        keepAlive: true,
        skipValidation: this.config.bot.skipValidation,
        ...(this.config.bot.auth === 'microsoft' ? { profilesFolder: this.config.bot.profilesFolder } : {})
      })
    } catch (err) {
      this.handleFatal(err)
      return Promise.resolve(false)
    }

    this.bot = bot
    this.wire(bot)
    return new Promise((resolve) => {
      const done = (ok) => {
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('end', onEnd)
        bot.removeListener('error', onError)
        resolve(ok)
      }
      const onSpawn = () => done(true)
      const onEnd = () => done(false)
      const onError = () => {
        /* 'end' follows; resolve there */
      }
      bot.once('spawn', onSpawn)
      bot.once('end', onEnd)
      bot.on('error', onError)
      // Never hang forever waiting for the first spawn.
      setTimeout(() => done(this.store.state.phase === 'online'), 30000).unref?.()
    })
  }

  wire (bot) {
    const store = this.store

    bot.on('login', () => {
      this.attempts = 0
      store.setState({
        phase: 'online',
        online: true,
        connectedAt: Date.now(),
        version: bot.version || bot.majorVersion || null,
        lastError: null,
        lastErrorHint: null,
        lastKick: null,
        attempts: 0
      })
      this.pushStatus(`Logged in — server reports Minecraft ${bot.version || 'unknown'}.`)
      this.startPlayerListWatch()
    })

    bot.on('spawn', () => {
      this.syncVitals()
      if (this.config.bot.joinMessage) {
        for (const line of this.config.bot.joinMessage.split('|').map((s) => s.trim()).filter(Boolean)) {
          this.sendChat(line, { source: 'auto' }).catch(() => {})
        }
      }
    })

    bot.on('message', (jsonMsg, position, sender, verified) => this.onServerMessage(jsonMsg, position, sender, verified))

    bot.on('kicked', (reason) => {
      const text = stripColors(typeof reason === 'string' ? reason : plain(reason))
      const info = explainFailure(reason)
      store.setState({ lastKick: text, lastError: info?.message || text, lastErrorHint: info?.hint || null })
      this.pushStatus(`Kicked: ${text || 'unknown reason'}${info?.hint ? `\n→ ${info.hint}` : ''}`, 'status')
    })

    bot.on('end', (reason) => {
      this.stopPlayerListWatch()
      store.setState({ online: false, connectedAt: null })
      if (this.stopping) {
        store.setState({ phase: 'stopped' })
        this.pushStatus(`Disconnected (${reason || 'quit'}).`)
        return
      }
      this.pushStatusOnce(`Disconnected${reason ? `: ${stripColors(String(reason))}` : ''}.`)
      this.scheduleReconnect(reason)
    })

    bot.on('error', (err) => {
      const info = explainFailure(err?.message || err)
      store.setState({ lastError: info?.message || String(err?.message || err), lastErrorHint: info?.hint || null })
      if (!store.state.online) {
        this.pushStatusOnce(`Connection error: ${info?.message || err?.message || err}${info?.hint ? `\n→ ${info.hint}` : ''}`)
      }
      // 'end' normally follows and triggers the reconnect. If it does not, do it here.
      clearTimeout(this._errorGuard)
      this._errorGuard = setTimeout(() => {
        if (!store.state.online && !this.reconnectTimer && !this.stopping) this.scheduleReconnect(err?.message)
      }, 2000)
      this._errorGuard.unref?.()
    })

    bot.on('health', () => this.syncVitals())
    bot.on('death', () => {
      this.pushStatus('The bot died. Waiting to respawn…')
      this.syncVitals()
    })
    bot.on('respawn', () => this.syncVitals())
    bot.on('time', () => this.syncTime())
    bot.on('playerJoined', () => this.syncPlayers())
    bot.on('playerLeft', () => this.syncPlayers())
  }

  /* ────────────────────────── inbound messages ────────────────────────── */

  onServerMessage (jsonMsg, position, sender, verified) {
    const store = this.store
    const isActionBar = position === 'game_info'
    if (isActionBar && !this.config.web.showActionBar) return

    const parsed = parseSpeaker(jsonMsg, {
      position,
      customPattern: this.config.bot.chatAuthorPattern
    })

    const fromSelf = parsed.author && parsed.author === this.config.bot.username
    const key = this.normalize(parsed.body || parsed.text)

    // Hide the server echo of a message we just sent through the dashboard.
    if (fromSelf && this.recentlySent.has(key)) {
      const sentAt = this.recentlySent.get(key)
      if (Date.now() - sentAt < 15000) {
        this.recentlySent.delete(key)
        return
      }
    }

    store.counters.received++
    store.push({
      kind: fromSelf ? 'bot' : parsed.kind,
      author: parsed.author,
      text: parsed.body || plain(jsonMsg),
      motd: motd(jsonMsg),
      meta: {
        position: position || 'chat',
        verified: verified === undefined ? null : !!verified,
        sender: sender ? String(typeof sender === 'object' && sender?.toString ? sender.toString() : sender) : null,
        full: plain(jsonMsg),
        self: !!fromSelf
      }
    })
  }

  /* ───────────────────────── outbound (from the site) ─────────────────── */

  normalize (text) {
    return stripColors(String(text || ''))
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 120)
  }

  /**
   * Queue a chat line / command to be sent as the bot.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async sendChat (text, meta = {}) {
    const message = String(text ?? '').trim()
    if (!message) return { ok: false, error: 'Empty message.' }
    if (message.length > 500) return { ok: false, error: 'Message too long (500 char max).' }
    if (!this.store.state.online || !this.bot) {
      return { ok: false, error: `Bot is not connected (phase: ${this.store.state.phase}).` }
    }
    if (this.queue.length >= 25) return { ok: false, error: 'Send queue is full — slow down.' }

    return new Promise((resolve) => {
      this.queue.push({ message, meta, resolve })
      this.drain()
    })
  }

  drain () {
    if (this.drainTimer || !this.queue.length) return
    const wait = Math.max(0, this.lastSendAt + this.config.web.sendCooldownMs - Date.now())
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      const item = this.queue.shift()
      if (!item) return
      this.lastSendAt = Date.now()

      if (!this.bot || !this.store.state.online) {
        item.resolve({ ok: false, error: 'Bot disconnected before the message could be sent.' })
        this.flushQueue('Bot disconnected.')
        return
      }

      try {
        this.bot.chat(item.message)
        const now = Date.now()
        this.recentlySent.set(this.normalize(item.message.replace(/^\//, '')), now)
        // Forget echoes older than a minute (servers that never echo would leak).
        if (this.recentlySent.size > 50) {
          for (const [k, t] of this.recentlySent) if (now - t > 60000) this.recentlySent.delete(k)
        }
        this.store.counters.sent++
        this.store.counters.web++

        // Instant feedback in the dashboard; the server echo is de-duplicated.
        if (!item.message.startsWith('/')) {
          this.store.push({
            kind: 'bot',
            author: this.config.bot.username,
            text: item.message,
            meta: { source: item.meta.source || 'web', pending: true, command: false }
          })
        } else {
          this.store.push({
            kind: 'status',
            author: null,
            text: `Command sent as ${this.config.bot.username}: ${item.message}`,
            meta: { source: item.meta.source || 'web', command: true }
          })
        }
        item.resolve({ ok: true })
      } catch (err) {
        item.resolve({ ok: false, error: err?.message || String(err) })
      }
      if (this.queue.length) this.drain()
    }, wait)
    // Deliberately NOT unref'd: a queued message is real work that must be
    // delivered before the process is allowed to exit.
  }

  flushQueue (error) {
    while (this.queue.length) {
      const item = this.queue.shift()
      item.resolve({ ok: false, error })
    }
  }

  /* ─────────────────────────── reconnection ───────────────────────────── */

  scheduleReconnect (reason) {
    const cfg = this.config.reconnect
    if (this.stopping || !cfg.enabled) {
      this.store.setState({ phase: 'stopped' })
      return
    }
    if (cfg.maxAttempts > 0 && this.attempts >= cfg.maxAttempts) {
      this.store.setState({ phase: 'error', lastError: `Gave up after ${this.attempts} attempts.` })
      this.pushStatus(`Stopped retrying after ${this.attempts} attempts.`)
      return
    }

    this.attempts++
    const delay = Math.min(cfg.maxDelayMs, cfg.delayMs * Math.pow(1.6, this.attempts - 1))
    const jitter = Math.floor(Math.random() * 1500)
    this.store.setState({ phase: 'reconnecting', attempts: this.attempts, online: false, connectedAt: null })
    this.pushStatus(`Reconnecting in ${Math.round((delay + jitter) / 1000)}s (attempt ${this.attempts})${reason ? ` — ${stripColors(String(reason))}` : ''}`)

    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopping) return
      this.connect(this.target).catch((err) => this.handleFatal(err))
    }, delay + jitter)
    this.reconnectTimer.unref?.()
  }

  handleFatal (err) {
    const info = explainFailure(err?.message || err)
    this.log('[bot] fatal:', info?.message || err?.message || err)
    this.store.setState({ phase: 'error', lastError: info?.message || String(err?.message || err), lastErrorHint: info?.hint || null })
    this.pushStatusOnce(`Fatal: ${info?.message || err?.message || err}${info?.hint ? `\n→ ${info.hint}` : ''}`)
    this.scheduleReconnect(err?.message)
  }

  async switchServer (labelOrHost) {
    const server = this.findServer(labelOrHost)
    if (!server) return { ok: false, error: `Unknown server "${labelOrHost}".` }
    if (this.target && server.label === this.target.label) return { ok: true, already: true }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempts = 0
    this.pushStatus(`Switching to ${server.label}…`)
    const ok = await this.connect(server)
    return { ok: !!ok, server: server.label }
  }

  async stop (reason = 'stopped by operator') {
    this.stopping = true
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.drainTimer)
    this.reconnectTimer = null
    this.drainTimer = null
    this.stopPlayerListWatch()
    this.flushQueue('Bot is shutting down.')
    this.teardownBot(reason)
    this.store.setState({ phase: 'stopped', online: false, connectedAt: null })
    this.pushStatus(`Bot stopped: ${reason}`)
  }

  teardownBot (reason) {
    clearTimeout(this._errorGuard)
    const bot = this.bot
    this.bot = null
    if (!bot) return
    try {
      bot.removeAllListeners()
      bot.quit(reason)
    } catch {
      /* already gone */
    }
  }

  /* ──────────────────────────── state sync ────────────────────────────── */

  syncVitals ({ light = false } = {}) {
    const bot = this.bot
    if (!bot || !bot.entity) return
    const patch = {}
    if (!light) {
      patch.health = typeof bot.health === 'number' ? Math.round(bot.health * 10) / 10 : null
      patch.food = typeof bot.food === 'number' ? bot.food : null
      patch.dimension = bot.game?.dimension ?? bot.game?.worldName ?? null
    }
    patch.position = formatPosition(bot.entity.position)
    this.store.setState(patch)
  }

  syncTime () {
    const bot = this.bot
    if (!bot || !bot.time) return
    const hours = Math.floor(((bot.time.timeOfDay + 6000) % 24000) / 1000)
    const minutes = Math.floor((((bot.time.timeOfDay + 6000) % 24000) % 1000) / 1000 * 60)
    this.store.setState({
      time: {
        day: bot.time.day,
        age: bot.time.age,
        clock: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      }
    })
  }

  syncPlayers () {
    const bot = this.bot
    if (!bot || !bot.players) return
    const list = Object.values(bot.players)
      .filter((p) => p && p.username)
      .map((p) => ({
        username: p.username,
        display: p.displayName ? plain(p.displayName) : p.username,
        ping: typeof p.ping === 'number' ? p.ping : null,
        gamemode: p.gamemode ?? null,
        isSelf: p.username === this.config.bot.username
      }))
      .sort((a, b) => a.username.localeCompare(b.username))
    this.store.setPlayers(list)
  }

  startPlayerListWatch () {
    this.stopPlayerListWatch()
    this.syncPlayers()
    this.playerListTimer = setInterval(() => {
      this.syncPlayers()
      this.syncVitals()
    }, 20000)
    this.playerListTimer.unref?.()
  }

  stopPlayerListWatch () {
    if (this.playerListTimer) clearInterval(this.playerListTimer)
    this.playerListTimer = null
  }

  /** Server-list ping: MOTD, player counts, version (best effort). */
  async refreshServerInfo (server = this.target) {
    if (!this.config.web.pingServer || !server) return null
    try {
      const info = await Promise.race([
        mc.ping({ host: server.host, port: server.port }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT))
      ])

      let text = ''
      let colored = null
      const desc = info.description
      try {
        const ChatMessage = require('prismarine-chat')(info.version?.name || '1.20.4')
        const msg = new ChatMessage(typeof desc === 'string' ? desc : desc || { text: '' })
        text = msg.toString()
        colored = msg.toMotd()
      } catch {
        text = componentText(desc)
      }

      const serverInfo = {
        motd: text,
        motdColored: colored,
        online: info.players?.online ?? null,
        max: info.players?.max ?? null,
        version: info.version?.name || null,
        protocol: info.version?.protocol || null,
        sample: (info.players?.sample || []).slice(0, 10).map((p) => p.name),
        fetchedAt: Date.now()
      }
      this.store.setState({ serverInfo, maxPlayers: serverInfo.max })
      return serverInfo
    } catch (err) {
      this.log('[bot] server ping failed:', err?.message || err)
      return null
    }
  }

  /* ────────────────────────────── helpers ─────────────────────────────── */

  pushStatus (text, kind = 'status') {
    this.log(`[bot] ${stripColors(text).split('\n')[0]}`)
    return this.store.push({ kind, text, author: null, meta: { source: 'bot-manager' } })
  }

  /**
   * Push a status line at most once per `windowMs`.
   * Mineflayer can emit the same underlying failure as both an 'error' and an
   * 'end', which would otherwise double every line in the dashboard.
   */
  pushStatusOnce (text, kind = 'status', windowMs = 6000) {
    const key = stripColors(text).slice(0, 160)
    const last = this._statusSeen?.get(key) || 0
    if (Date.now() - last < windowMs) return null
    this._statusSeen = this._statusSeen || new Map()
    this._statusSeen.set(key, Date.now())
    if (this._statusSeen.size > 40) this._statusSeen.clear()
    return this.pushStatus(text, kind)
  }

  /** Extra actions the dashboard can trigger. */
  async action (name) {
    // 'reconnect' must also work while offline — that is when you need it most.
    if (name === 'reconnect') {
      this.stopping = false
      this.attempts = 0
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.connect(this.target).catch((e) => this.handleFatal(e))
      return { ok: true }
    }
    if (!this.bot || !this.store.state.online) return { ok: false, error: 'Bot is offline.' }
    switch (name) {
      case 'respawn':
        try {
          this.bot.respawn?.()
        } catch {
          /* noop */
        }
        return { ok: true }
      case 'refresh-players':
        this.syncPlayers()
        return { ok: true }
      case 'refresh-server-info':
        await this.refreshServerInfo()
        return { ok: true }
      default:
        return { ok: false, error: `Unknown action "${name}".` }
    }
  }
}

module.exports = { BotManager }
