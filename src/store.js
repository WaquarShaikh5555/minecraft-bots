'use strict'

/**
 * In-memory store shared by the bot and the web layer.
 *
 *  • keeps a ring buffer of chat lines and replays them to new visitors
 *  • keeps the live bot state (server, health, players, connection phase)
 *  • is a tiny event emitter: `on('message')` / `on('state')`
 *  • optionally appends every line to a JSONL file
 */

const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')

const KINDS = ['chat', 'system', 'whisper', 'actionbar', 'bot', 'player', 'status', 'web']

class Store extends EventEmitter {
  constructor ({ historySize = 400, logFile = null } = {}) {
    super()
    this.setMaxListeners(0)
    this.historySize = Math.max(1, historySize)
    this.buffer = []
    this.nextId = 1
    this.counters = { received: 0, sent: 0, web: 0, dropped: 0 }

    this.state = {
      phase: 'idle', // idle | connecting | online | reconnecting | stopped | error
      username: null,
      server: null, // { host, port, label }
      servers: [],
      auth: 'offline',
      version: null,
      connectedAt: null,
      startedAt: Date.now(),
      attempts: 0,
      lastError: null,
      lastErrorHint: null,
      lastKick: null,
      health: null,
      food: null,
      position: null,
      dimension: null,
      time: null,
      players: [],
      playerCount: 0,
      maxPlayers: null,
      serverInfo: null, // MOTD / counts from a server-list ping
      online: false
    }

    this.logFile = logFile
    this.logStream = null
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true })
        this.logStream = fs.createWriteStream(path.resolve(logFile), { flags: 'a' })
        this.logStream.on('error', () => {
          this.logStream = null
        })
      } catch {
        this.logStream = null
      }
    }
  }

  /* ───────────────────────────── messages ───────────────────────────── */

  /**
   * @param {object} msg
   * @param {string} msg.kind   one of KINDS
   * @param {string} msg.text   plain text
   * @param {string} [msg.motd] text with Minecraft § colour codes
   * @param {string} [msg.author]
   * @param {object} [msg.meta]  anything extra (uuid, position, source, ...)
   */
  push (msg) {
    const kind = KINDS.includes(msg.kind) ? msg.kind : 'system'
    const record = {
      id: this.nextId++,
      ts: msg.ts || Date.now(),
      kind,
      author: msg.author || null,
      text: String(msg.text ?? ''),
      motd: msg.motd || null,
      server: msg.server || (this.state.server ? this.state.server.label : null),
      meta: msg.meta || null
    }

    this.buffer.push(record)
    while (this.buffer.length > this.historySize) {
      this.buffer.shift()
      this.counters.dropped++
    }

    if (this.logStream) {
      try {
        this.logStream.write(JSON.stringify(record) + '\n')
      } catch {
        /* never let logging break the app */
      }
    }

    this.emit('message', record)
    return record
  }

  /** Messages after `sinceId` (exclusive). */
  since (sinceId = 0, limit = this.historySize) {
    if (!sinceId) return this.buffer.slice(-limit)
    const out = []
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].id <= sinceId) break
      out.unshift(this.buffer[i])
    }
    return out.slice(-limit)
  }

  lastId () {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].id : 0
  }

  clear () {
    this.buffer = []
    this.emit('cleared')
  }

  /* ─────────────────────────────── state ─────────────────────────────── */

  setState (patch = {}) {
    let changed = false
    for (const [key, value] of Object.entries(patch)) {
      if (JSON.stringify(this.state[key]) !== JSON.stringify(value)) {
        this.state[key] = value
        changed = true
      }
    }
    if (changed) this.emit('state', this.getState())
    return this.state
  }

  getState () {
    const s = this.state
    return {
      ...s,
      uptimeMs: s.connectedAt ? Date.now() - s.connectedAt : 0,
      runtimeMs: Date.now() - s.startedAt,
      counters: { ...this.counters },
      historySize: this.historySize,
      buffered: this.buffer.length
    }
  }

  setPlayers (players) {
    const list = players.map((p) => ({
      username: p.username,
      display: p.display || p.displayName || p.username,
      ping: typeof p.ping === 'number' ? p.ping : null,
      gamemode: p.gamemode ?? null,
      isSelf: !!p.isSelf
    }))
    this.setState({ players: list, playerCount: list.length })
  }

  close () {
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch {
        /* noop */
      }
      this.logStream = null
    }
  }
}

module.exports = { Store, KINDS }
