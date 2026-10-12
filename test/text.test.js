'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseSpeaker, explainFailure, stripColors, formatPosition, componentText } = require('../src/text')
const { parseServers } = require('../src/config')

/** Minimal stand-in for a prismarine-chat message. */
const msg = (json, text) => ({
  json,
  toString: () => text ?? componentText(json),
  toMotd: () => (json && json.motd) || text || null
})

test('parseSpeaker: vanilla "<name> text"', () => {
  const out = parseSpeaker(msg({ text: '<waquar5555> hello world' }), { position: 'chat' })
  assert.equal(out.author, 'waquar5555')
  assert.equal(out.body, 'hello world')
  assert.equal(out.kind, 'chat')
})

test('parseSpeaker: 1.19+ client-side chat formatting', () => {
  const out = parseSpeaker(
    msg({ translate: '<%s> %s', with: [{ text: 'Alex' }, { text: 'gg' }] }, '<Alex> gg'),
    { position: 'chat' }
  )
  assert.equal(out.author, 'Alex')
  assert.equal(out.body, 'gg')
})

test('parseSpeaker: whisper keeps the sender', () => {
  const out = parseSpeaker(
    msg({ translate: 'commands.message.display.incoming', with: [{ text: 'Steve_' }, { text: 'psst' }] }, 'Steve_ whispers to you: psst'),
    { position: 'chat' }
  )
  assert.equal(out.kind, 'whisper')
  assert.equal(out.author, 'Steve_')
  assert.equal(out.body, 'psst')
})

test('parseSpeaker: system / action bar positions', () => {
  assert.equal(parseSpeaker(msg({ text: '[Server] saved' }), { position: 'system' }).kind, 'system')
  assert.equal(parseSpeaker(msg({ text: '♥♥♥' }), { position: 'game_info' }).kind, 'actionbar')
})

test('parseSpeaker: join/leave become "player"', () => {
  const out = parseSpeaker(msg({ translate: 'multiplayer.player.joined', with: [{ text: 'Bob' }] }, 'Bob joined the game'), {
    position: 'system'
  })
  assert.equal(out.kind, 'player')
})

test('parseSpeaker: custom pattern for prefix-heavy servers', () => {
  const out = parseSpeaker(msg({ text: '[VIP] Waquar5555 » hey' }), {
    position: 'chat',
    customPattern: '^(?:\\[[^\\]]+\\]\\s*)?(\\w{3,16})\\s*»\\s*(.*)$'
  })
  assert.equal(out.author, 'Waquar5555')
  assert.equal(out.body, 'hey')
})

test('parseSpeaker: never throws on garbage input', () => {
  assert.doesNotThrow(() => parseSpeaker(null, {}))
  assert.doesNotThrow(() => parseSpeaker({ json: null, toString: () => { throw new Error('boom') } }, {}))
  assert.doesNotThrow(() => parseSpeaker(undefined, { position: 'chat' }))
})

test('explainFailure: detects an online-mode server', () => {
  const info = explainFailure('Disconnected: Failed to verify username!')
  assert.equal(info.code, 'online_mode')
  assert.match(info.hint, /MC_AUTH=microsoft/)
})

test('explainFailure: detects version and network problems', () => {
  assert.equal(explainFailure('Outdated client! Please use 1.20.4').code, 'version')
  assert.equal(explainFailure('connect ETIMEDOUT 1.2.3.4:25565').code, 'network')
  assert.equal(explainFailure('getaddrinfo ENOTFOUND world.arterex.me').code, 'network')
  assert.equal(explainFailure('You are sending messages too fast').code, 'rate_limited')
  assert.equal(explainFailure('some random plugin message').code, 'other')
  assert.equal(explainFailure(''), null)
})

test('stripColors + formatPosition', () => {
  assert.equal(stripColors('§aHello §lworld§r'), 'Hello world')
  assert.deepEqual(formatPosition({ x: 12.6, y: 64.1, z: -8.4 }), { x: 13, y: 64, z: -8 })
  assert.equal(formatPosition(null), null)
})

test('parseServers: host, host:port, multiple, srv:// prefix', () => {
  assert.deepEqual(parseServers('world.arterex.me'), [{ host: 'world.arterex.me', port: 25565, label: 'world.arterex.me' }])
  assert.deepEqual(parseServers('a.net:25566, srv://b.net:25567 ,c.net'), [
    { host: 'a.net', port: 25566, label: 'a.net:25566' },
    { host: 'b.net', port: 25567, label: 'b.net:25567' },
    { host: 'c.net', port: 25565, label: 'c.net' }
  ])
  assert.deepEqual(parseServers('', 'fallback.net'), [{ host: 'fallback.net', port: 25565, label: 'fallback.net' }])
})
