'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { Store } = require('../src/store')

test('ring buffer keeps the newest N messages', () => {
  const store = new Store({ historySize: 5, logFile: null })
  for (let i = 0; i < 12; i++) store.push({ kind: 'chat', text: `m${i}` })
  assert.equal(store.buffer.length, 5)
  assert.deepEqual(store.buffer.map((m) => m.text), ['m7', 'm8', 'm9', 'm10', 'm11'])
  assert.equal(store.counters.dropped, 7)
})

test('since() returns only newer messages', () => {
  const store = new Store({ historySize: 100, logFile: null })
  for (let i = 0; i < 6; i++) store.push({ kind: 'chat', text: `m${i}` })
  const id = store.buffer[2].id
  assert.deepEqual(store.since(id).map((m) => m.text), ['m3', 'm4', 'm5'])
  assert.equal(store.since(0).length, 6)
  assert.equal(store.since(store.lastId()).length, 0)
})

test('unknown kinds are coerced to system', () => {
  const store = new Store({ logFile: null })
  assert.equal(store.push({ kind: 'nonsense', text: 'x' }).kind, 'system')
})

test('setState only emits when something actually changed', () => {
  const store = new Store({ logFile: null })
  let emissions = 0
  store.on('state', () => emissions++)
  store.setState({ phase: 'online' })
  store.setState({ phase: 'online' })
  store.setState({ phase: 'reconnecting', health: 20 })
  assert.equal(emissions, 2)
  assert.equal(store.state.phase, 'reconnecting')
})

test('getState exposes derived uptime and counters', () => {
  const store = new Store({ logFile: null })
  store.setState({ connectedAt: Date.now() - 60000 })
  store.counters.received = 3
  const s = store.getState()
  assert.ok(s.uptimeMs >= 59000 && s.uptimeMs <= 61000)
  assert.equal(s.counters.received, 3)
})

test('setPlayers normalises and counts', () => {
  const store = new Store({ logFile: null })
  store.setPlayers([
    { username: 'a', ping: 40 },
    { username: 'b', displayName: 'Bee', ping: 120, isSelf: true }
  ])
  assert.equal(store.state.playerCount, 2)
  assert.deepEqual(store.state.players[1], { username: 'b', display: 'Bee', ping: 120, gamemode: null, isSelf: true })
})

test('messages are emitted live', () => {
  const store = new Store({ logFile: null })
  const seen = []
  store.on('message', (m) => seen.push(m.text))
  store.push({ kind: 'chat', text: 'hello' })
  assert.deepEqual(seen, ['hello'])
})
