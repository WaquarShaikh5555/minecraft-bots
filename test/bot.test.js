'use strict'

/**
 * Integration test for BotManager's failure handling.
 *
 * No Minecraft server is needed: we point the bot at a closed port and check
 * that it reports a useful error, schedules a reconnect, and shuts down cleanly.
 */

process.env.NODE_ENV = 'test'
process.env.MC_USERNAME = 'waquar5555'
process.env.MC_SERVERS = '127.0.0.1:1'
process.env.MC_AUTH = 'offline'
process.env.RECONNECT = 'true'
process.env.RECONNECT_DELAY_MS = '150'
process.env.RECONNECT_MAX_DELAY_MS = '300'
process.env.PING_SERVER = 'false'
process.env.CHAT_TOKEN = 'integration-test-token-1234567890'
process.env.CHAT_LOG_FILE = 'false'

const test = require('node:test')
const assert = require('node:assert/strict')

const { config } = require('../src/config')
const { Store } = require('../src/store')
const { BotManager } = require('../src/bot')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const silent = () => {}

test('findServer resolves labels, hosts and host:port', () => {
  const store = new Store({ logFile: null })
  const bot = new BotManager(store, { ...config, bot: { ...config.bot, servers: [
    { host: 'a.test', port: 25565, label: 'a.test:25565' },
    { host: 'b.test', port: 25566, label: 'b.test:25566' }
  ] } }, silent)
  assert.equal(bot.findServer('a.test:25565').host, 'a.test')
  assert.equal(bot.findServer('b.test').port, 25566)
  assert.equal(bot.findServer('nope.test'), null)
  assert.equal(bot.findServer().host, 'a.test')
})

test('unreachable server: error is explained and a reconnect is scheduled', async (t) => {
  const store = new Store({ logFile: null })
  const bot = new BotManager(store, config, silent)
  t.after(() => bot.stop('test done'))

  const ok = await bot.connect()
  assert.equal(ok, false, 'connect() should resolve false when the server is unreachable')
  assert.equal(store.state.online, false)

  await sleep(400) // let the reconnect timer fire at least once
  assert.ok(['connecting', 'reconnecting', 'error'].includes(store.state.phase), `unexpected phase ${store.state.phase}`)
  assert.ok(store.state.lastError, 'lastError should be populated')

  const status = store.buffer.filter((m) => m.kind === 'status').map((m) => m.text).join('\n')
  assert.match(status, /Connecting to 127\.0\.0\.1:1/)
  assert.match(status, /error|Disconnected|Reconnecting/i)

  // The dashboard hint should tell the operator what to do.
  const explained = status + (store.state.lastErrorHint || '')
  assert.ok(/reach the server|hostname\/port|outbound/i.test(explained), 'expected a network hint')

  await bot.stop('test done')
  assert.equal(store.state.phase, 'stopped')
  assert.equal(bot.reconnectTimer, null)
})

test('sendChat refuses while offline and validates input', async (t) => {
  const store = new Store({ logFile: null })
  const bot = new BotManager(store, config, silent)
  t.after(() => bot.stop('test done'))

  const offline = await bot.sendChat('hello')
  assert.equal(offline.ok, false)
  assert.match(offline.error, /not connected/i)

  assert.equal((await bot.sendChat('   ')).ok, false)
  assert.equal((await bot.sendChat('x'.repeat(600))).ok, false)
  assert.equal((await bot.action('respawn')).ok, false)
  assert.equal((await bot.switchServer('nowhere.test')).ok, false)
})

test('switchServer rejects unknown labels', async (t) => {
  const store = new Store({ logFile: null })
  const bot = new BotManager(store, config, silent)
  t.after(() => bot.stop('test done'))
  const res = await bot.switchServer('does.not.exist')
  assert.equal(res.ok, false)
  assert.match(res.error, /Unknown server/)
})

test('outgoing chat is throttled by the send queue', async (t) => {
  const store = new Store({ historySize: 50, logFile: null })
  const cfg = {
    ...config,
    web: { ...config.web, sendCooldownMs: 60 },
    bot: { ...config.bot }
  }
  const bot = new BotManager(store, cfg, silent)
  t.after(() => bot.stop('test done'))

  // Fake an online bot so the queue logic can be exercised offline.
  const sent = []
  bot.bot = { chat: (m) => sent.push(m) }
  store.setState({ phase: 'online', online: true })

  const results = await Promise.all([bot.sendChat('one'), bot.sendChat('two'), bot.sendChat('three')])
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }])
  assert.deepEqual(sent, ['one', 'two', 'three'])

  // Each send must respect the cooldown, so the three took >= 2 intervals.
  const queued = store.buffer.filter((m) => m.kind === 'bot')
  assert.equal(queued.length, 3)
  assert.ok(queued[2].ts - queued[0].ts >= 100, 'messages should be spaced out')
})

test('commands are logged as status, not echoed as chat', async (t) => {
  const store = new Store({ logFile: null })
  const bot = new BotManager(store, { ...config, web: { ...config.web, sendCooldownMs: 0 } }, silent)
  t.after(() => bot.stop('test done'))

  bot.bot = { chat: () => {} }
  store.setState({ phase: 'online', online: true })
  await bot.sendChat('/list')

  const last = store.buffer[store.buffer.length - 1]
  assert.equal(last.kind, 'status')
  assert.match(last.text, /Command sent as waquar5555: \/list/)
  assert.equal(last.meta.command, true)
})
