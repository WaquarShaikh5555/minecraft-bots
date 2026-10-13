'use strict'

/**
 * DemoBot — a stand-in for BotManager that fakes a live connection.
 *
 * Used by `npm run dev -- --demo` (or DEMO=true) so you can build and preview
 * the dashboard before the bot can actually reach a Minecraft server.
 * It implements the same surface as BotManager: sendChat / action / switchServer.
 */

const NAMES = ['Steve_', 'Alex', 'Notch', 'CreeperKing', 'waquar5555', 'Herobrine', 'BuilderBob', 'xzNinja']
const LINES = [
  { author: 'Steve_', text: 'anyone want to trade iron?', motd: '§fanyone want to trade §7iron§f?' },
  { author: 'Alex', text: 'gg that was close', motd: '§agg that was close' },
  { author: 'CreeperKing', text: 'don\'t dig straight down, trust me', motd: "§cdon't dig straight down, §7trust me" },
  { author: 'BuilderBob', text: 'spawn is looking clean today', motd: '§6spawn is looking §eclean§6 today' },
  { author: 'xzNinja', text: '/tpa BuilderBob', motd: '§7/tpa BuilderBob' },
  { author: 'Herobrine', text: 'hello from the other side', motd: '§5hello from the §dother side' },
  { text: '[Server] Auto-save complete.', motd: '§8[Server] §7Auto-save complete.', kind: 'system' },
  { text: 'Alex joined the game', motd: '§eAlex joined the game', kind: 'player' },
  { text: 'CreeperKing left the game', motd: '§eCreeperKing left the game', kind: 'player' },
  { author: 'Steve_', text: 'the nether portal is at 120, -48', motd: '§fthe nether portal is at §b120, -48' }
]

class DemoBot {
  constructor (store, config) {
    this.store = store
    this.config = config
    this.timers = []
    this.players = NAMES.slice(0, 5).map((username) => ({
      username,
      display: username,
      ping: 20 + Math.floor(Math.random() * 120),
      gamemode: 'survival',
      isSelf: username === config.bot.username
    }))

    const server = config.bot.servers[0] || { host: 'demo.example.net', port: 25565, label: 'demo.example.net' }
    store.setState({
      phase: 'online',
      online: true,
      username: config.bot.username,
      auth: config.bot.auth,
      server,
      servers: config.bot.servers,
      version: '1.20.4',
      connectedAt: Date.now() - 1000 * 60 * 42,
      health: 20,
      food: 18,
      position: { x: 128, y: 64, z: -256 },
      dimension: 'minecraft:overworld',
      time: { day: 7, age: 7 * 24000 + 6000, clock: '12:00' },
      maxPlayers: 40,
      serverInfo: {
        motd: '§6Arterex §8» §fSurvival §7| §a1.20.x§r\n§8demo mode — no real server connected',
        motdColored: '§6Arterex §8» §fSurvival',
        online: this.players.length,
        max: 40,
        version: '1.20.4',
        protocol: 765,
        sample: [],
        fetchedAt: Date.now()
      }
    })
    store.setPlayers(this.players)

    store.push({
      kind: 'status',
      text: `DEMO MODE — no Minecraft connection. Started with \`--demo\`. UI is fully interactive.`,
      meta: { source: 'demo' }
    })
  }

  start () {
    this.every(() => this.tickChat(), 4000, 9000)
    this.every(() => this.tickWorld(), 5000, 5000)
    return Promise.resolve(true)
  }

  every (fn, min, max) {
    const loop = () => {
      const t = setTimeout(() => {
        try {
          fn()
        } catch {
          /* keep the demo alive no matter what */
        }
        loop()
      }, min + Math.random() * max)
      t.unref?.()
      this.timers.push(t)
    }
    loop()
  }

  tickChat () {
    const line = LINES[Math.floor(Math.random() * LINES.length)]
    this.store.push({
      kind: line.kind || (line.author ? 'chat' : 'system'),
      author: line.author || null,
      text: line.text,
      motd: line.motd || null,
      meta: { position: 'chat', demo: true }
    })
    this.store.counters.received++
  }

  tickWorld () {
    const s = this.store.state
    const pos = s.position || { x: 0, y: 64, z: 0 }
    this.store.setState({
      health: Math.max(1, Math.min(20, (s.health ?? 20) + (Math.random() < 0.3 ? -1 : 0))),
      food: Math.max(0, Math.min(20, (s.food ?? 20) + (Math.random() < 0.2 ? -1 : 0))),
      position: {
        x: pos.x + Math.round((Math.random() - 0.5) * 8),
        y: pos.y,
        z: pos.z + Math.round((Math.random() - 0.5) * 8)
      },
      players: this.players.map((p) => ({ ...p, ping: Math.max(8, p.ping + Math.round((Math.random() - 0.5) * 12)) }))
    })
  }

  async sendChat (text, meta = {}) {
    const message = String(text ?? '').trim()
    if (!message) return { ok: false, error: 'Empty message.' }
    this.store.counters.sent++
    this.store.counters.web++

    if (message.startsWith('/')) {
      this.store.push({
        kind: 'status',
        text: `Command sent as ${this.config.bot.username}: ${message}`,
        meta: { source: meta.source || 'web', command: true, demo: true }
      })
      const reply =
        message.startsWith('/list')
          ? `There are ${this.players.length}/${this.store.state.maxPlayers ?? 40} players online: ${this.players.map((p) => p.username).join(', ')}`
          : `Unknown or demo-only command: ${message.split(' ')[0]}`
      setTimeout(() => this.store.push({ kind: 'system', text: reply, meta: { demo: true } }), 600)
      return { ok: true }
    }

    this.store.push({
      kind: 'bot',
      author: this.config.bot.username,
      text: message,
      meta: { source: meta.source || 'web', demo: true }
    })

    // Somebody answers, because a demo with no feedback is boring.
    const who = NAMES.filter((n) => n !== this.config.bot.username)[Math.floor(Math.random() * (NAMES.length - 1))]
    const answer = ['nice', 'lol', 'agreed', 'where are you?', 'come to spawn', '+1', 'brb', 'on my way'][
      Math.floor(Math.random() * 8)
    ]
    setTimeout(() => {
      this.store.push({ kind: 'chat', author: who, text: answer, motd: `§f${answer}`, meta: { demo: true } })
    }, 900 + Math.random() * 2000)
    return { ok: true }
  }

  async action (name) {
    if (name === 'reconnect') {
      this.store.setState({ phase: 'connecting', online: false })
      this.store.push({ kind: 'status', text: 'Demo: pretending to reconnect…', meta: { demo: true } })
      setTimeout(() => {
        this.store.setState({ phase: 'online', online: true, connectedAt: Date.now() })
        this.store.push({ kind: 'status', text: 'Demo: back online.', meta: { demo: true } })
      }, 2500)
      return { ok: true }
    }
    return { ok: true }
  }

  async switchServer (label) {
    const server = this.config.bot.servers.find((s) => s.label === label || s.host === label)
    if (!server) return { ok: false, error: `Unknown server "${label}".` }
    this.store.setState({ server, phase: 'connecting', online: false })
    setTimeout(() => this.store.setState({ phase: 'online', online: true, connectedAt: Date.now() }), 1500)
    return { ok: true, server: server.label }
  }

  async stop () {
    this.timers.forEach(clearTimeout)
    this.timers = []
    this.store.setState({ phase: 'stopped', online: false })
  }
}

module.exports = { DemoBot }
