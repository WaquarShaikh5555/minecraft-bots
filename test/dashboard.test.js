'use strict'

/**
 * Dashboard tests: the real index.html + app.js run inside jsdom against the
 * real Express/WebSocket server (bot replaced by a stub).
 *
 * This is what catches "the page renders but nothing happens" bugs.
 */

process.env.NODE_ENV = 'test'
process.env.CHAT_TOKEN = 'dashboard-test-token-0123456789'
process.env.PORT = '0'
process.env.NO_BOT = 'true'
process.env.PING_SERVER = 'false'
process.env.ALLOW_ANONYMOUS_CHAT = 'false'
process.env.ALLOW_SERVER_SWITCH = 'false'
process.env.CHAT_LOG_FILE = 'false'
process.env.MC_SERVERS = 'world.arterex.me:25565'
process.env.MC_USERNAME = 'waquar5555'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const { config } = require('../src/config')
const { Store } = require('../src/store')
const { createServer } = require('../src/server')

config.web.logFile = null

const PUBLIC = path.join(__dirname, '..', 'public')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor (fn, { timeout = 4000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    let value
    try {
      value = await fn()
    } catch {
      value = false
    }
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`)
    await sleep(25)
  }
}

function stubBot (store) {
  return {
    sent: [],
    async start () {
      store.setState({
        phase: 'online',
        online: true,
        username: config.bot.username,
        auth: 'offline',
        server: config.bot.servers[0],
        servers: config.bot.servers,
        version: '1.20.4',
        connectedAt: Date.now() - 60000,
        health: 17,
        food: 12,
        position: { x: 12, y: 64, z: -88 },
        dimension: 'minecraft:overworld',
        time: { day: 3, age: 78000, clock: '14:30' },
        serverInfo: { motd: 'Arterex Survival', motdColored: '§6Arterex §fSurvival', online: 4, max: 40, version: '1.20.4', protocol: 765 }
      })
      store.setPlayers([
        { username: 'waquar5555', ping: 30, isSelf: true },
        { username: 'Alex', ping: 120 },
        { username: 'Steve_', ping: 250 }
      ])
      return true
    },
    async stop () {},
    async sendChat (text) {
      this.sent.push(text)
      store.push({ kind: 'bot', author: config.bot.username, text, meta: { source: 'web' } })
      return { ok: true }
    },
    async action () {
      return { ok: true }
    },
    async switchServer () {
      return { ok: false, error: 'disabled' }
    }
  }
}

async function boot () {
  const store = new Store({ historySize: 100, logFile: null })
  const bot = stubBot(store)
  await bot.start()
  const web = createServer({ store, bot, config, log: () => {} })
  const server = http.createServer(web.app)
  web.attachWebSocket(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { store, bot, web, server, port, base: `http://127.0.0.1:${port}` }
}

/** Load the real dashboard into jsdom and point it at the test server. */
async function loadDashboard (app) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  const dom = new JSDOM(html, {
    url: `${app.base}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  })
  const { window } = dom

  // jsdom has no fetch; Node's is fine because app.js builds absolute URLs.
  window.fetch = (...args) => fetch(...args)
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener () {}, removeListener () {}, addEventListener () {}, removeEventListener () {} })
  }

  window.eval(fs.readFileSync(path.join(PUBLIC, 'config.js'), 'utf8'))
  window.eval(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'))

  return { dom, window, document: window.document, $: (sel) => window.document.querySelector(sel) }
}

const rowsOf = (doc) => Array.from(doc.querySelectorAll('#feed .row'))
const textOf = (doc) => rowsOf(doc).map((r) => r.textContent)

test('dashboard renders the replayed history and live state', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  app.store.push({ kind: 'chat', author: 'Alex', text: 'hello world', motd: '§ahello world' })
  app.store.push({ kind: 'system', text: '[Server] Auto-save complete.' })
  app.store.push({ kind: 'player', text: 'Steve_ joined the game' })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())

  await waitFor(() => rowsOf(ui.document).length >= 3, { label: '3 feed rows' })

  const rows = rowsOf(ui.document)
  assert.equal(rows[0].dataset.kind, 'chat')
  assert.equal(rows[0].querySelector('.who').textContent, 'Alex')
  assert.equal(rows[0].querySelector('.body').textContent, 'hello world')
  assert.equal(rows[1].dataset.kind, 'system')
  assert.equal(rows[2].dataset.kind, 'player')

  // state panel
  await waitFor(() => ui.$('#phaseText').textContent === 'online', { label: 'phase pill' })
  assert.equal(ui.$('#botName').textContent, 'waquar5555')
  assert.match(ui.$('#serverLabel').textContent, /world\.arterex\.me:25565/)
  assert.equal(ui.$('#srvVersion').textContent, '1.20.4')
  assert.equal(ui.$('#srvPlayers').textContent, '4/40')
  assert.equal(ui.$('#healthVal').textContent, '17/20')
  assert.equal(ui.$('#healthBar').style.width, '85%')
  assert.equal(ui.$('#botPos').textContent, '12, 64, -88')
  assert.equal(ui.$('#botDim').textContent, 'overworld')
  assert.match(ui.$('#botTime').textContent, /day 3 · 14:30/)
  assert.equal(ui.$('#motd').textContent, 'Arterex Survival')

  // players list
  const players = Array.from(ui.document.querySelectorAll('#playerList li'))
  assert.equal(players.length, 3)
  assert.ok(players[0].classList.contains('is-self'))
  assert.match(players[2].textContent, /250ms/)

  // socket + phase pills
  assert.equal(ui.$('#socketPill').dataset.state, 'open')
  assert.equal(ui.$('#phasePill').dataset.phase, 'online')
})

test('§ colour codes become styled spans', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  app.store.push({
    kind: 'chat',
    author: 'Alex',
    text: 'red then bold',
    motd: '§cred §lbold§r plain'
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => rowsOf(ui.document).length >= 1, { label: 'a row' })

  const body = ui.$('#feed .row .body')
  const spans = Array.from(body.querySelectorAll('span'))
  assert.equal(body.textContent.replace(/\s+/g, ' ').trim(), 'red bold plain')

  const red = spans.find((s) => s.textContent.includes('red'))
  assert.ok(red, 'expected a red segment')
  assert.match(red.style.color, /rgb\(255, 85, 85\)/i)

  const bold = spans.find((s) => s.textContent.includes('bold'))
  assert.equal(bold.style.fontWeight, '800')
})

test('hostile chat cannot inject HTML', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const attack = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'
  app.store.push({ kind: 'chat', author: 'Eve', text: attack, motd: `§c${attack}` })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => rowsOf(ui.document).length >= 1, { label: 'a row' })

  assert.equal(ui.document.querySelectorAll('#feed img').length, 0)
  assert.equal(ui.document.querySelectorAll('#feed script').length, 0)
  assert.equal(ui.window.__pwned, undefined)
  assert.ok(ui.$('#feed .row .body').textContent.includes('<img src=x'))
})

test('the composer is locked until a valid token is entered', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => rowsOf(ui.document).length >= 0 && ui.$('#socketPill').dataset.state === 'open', {
    label: 'socket open'
  })

  assert.equal(ui.$('#input').disabled, true, 'input must start disabled without a token')
  assert.equal(ui.$('#authState').textContent, 'token needed — ⚙ Settings')

  // Type the token into Settings and save.
  ui.$('#btnSettings').click()
  assert.equal(ui.$('#settingsModal').hidden, false)
  ui.$('#tokenInput').value = config.web.chatToken
  ui.$('#btnSaveSettings').click()

  await waitFor(() => ui.$('#input').disabled === false, { label: 'input enabled after token' })
  assert.equal(ui.$('#authState').textContent, 'token ok')
  assert.equal(ui.window.localStorage.getItem('mc-bridge-prefs-v1').includes(config.web.chatToken), true)

  // Now send a message through the form.
  ui.$('#input').value = 'hello from jsdom'
  ui.$('#input').dispatchEvent(new ui.window.Event('input', { bubbles: true }))
  assert.equal(ui.$('#charCount').textContent, '16')
  ui.$('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }))

  await waitFor(() => app.bot.sent.length === 1, { label: 'bot received the message' })
  assert.equal(app.bot.sent[0], 'hello from jsdom')
  assert.equal(ui.$('#input').value, '')

  // …and it shows up in the feed as a "mine" row.
  await waitFor(() => rowsOf(ui.document).some((r) => r.dataset.kind === 'bot'), { label: 'bot row' })
  const mineRow = rowsOf(ui.document).find((r) => r.dataset.kind === 'bot')
  assert.ok(mineRow.classList.contains('is-own'))
  assert.match(mineRow.textContent, /waquar5555/)
})

test('a wrong token is rejected and reported', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => ui.$('#socketPill').dataset.state === 'open', { label: 'socket open' })

  ui.$('#btnSettings').click()
  ui.$('#tokenInput').value = 'definitely-wrong'
  ui.$('#btnSaveSettings').click()

  await waitFor(() => ui.$('#input').disabled === true, { label: 'still disabled' })
  await waitFor(() => ui.$('#authState').textContent === 'token needed — ⚙ Settings', { label: 'auth label' })
})

test('filters and search narrow the feed', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  app.store.push({ kind: 'chat', author: 'Alex', text: 'about diamonds' })
  app.store.push({ kind: 'system', text: 'server restarting soon' })
  app.store.push({ kind: 'chat', author: 'Steve_', text: 'about iron' })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => rowsOf(ui.document).length >= 3, { label: '3 rows' })

  ui.document.querySelector('[data-filter="system"]').click()
  await waitFor(() => rowsOf(ui.document).length === 1, { label: 'system filter' })
  assert.match(textOf(ui.document)[0], /server restarting/)

  ui.document.querySelector('[data-filter="all"]').click()
  await waitFor(() => rowsOf(ui.document).length === 3, { label: 'back to all' })

  ui.$('#search').value = 'diamonds'
  ui.$('#search').dispatchEvent(new ui.window.Event('input', { bubbles: true }))
  await waitFor(() => rowsOf(ui.document).length === 1, { label: 'search filter' })
  assert.match(textOf(ui.document)[0], /diamonds/)
})

test('clicking a player pre-fills a /msg command', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => ui.document.querySelectorAll('#playerList li').length >= 2, { label: 'players' })

  const alex = Array.from(ui.document.querySelectorAll('#playerList li')).find((li) => li.textContent.includes('Alex'))
  alex.click()
  assert.equal(ui.$('#input').value, '/msg Alex ')
})

test('new lines stream in live while the page is open', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => ui.$('#socketPill').dataset.state === 'open', { label: 'socket open' })
  const before = rowsOf(ui.document).length

  app.store.counters.received++   // the real bot does this before pushing
  app.store.push({ kind: 'chat', author: 'Notch', text: 'streamed live', motd: '§estreamed live' })
  await waitFor(() => rowsOf(ui.document).length === before + 1, { label: 'new row' })
  assert.match(rowsOf(ui.document)[rowsOf(ui.document).length - 1].textContent, /streamed live/)

  // Counters come over the socket with the message.
  await waitFor(() => ui.$('#statReceived').textContent === '1', { label: 'counter' })
})

test('state changes update the pill and the banner', async (t) => {
  const app = await boot()
  t.after(() => {
    app.web.close()
    app.server.close()
  })

  const ui = await loadDashboard(app)
  t.after(() => ui.window.close())
  await waitFor(() => ui.$('#phaseText').textContent === 'online', { label: 'online' })

  app.store.setState({
    phase: 'reconnecting',
    online: false,
    attempts: 2,
    lastError: 'connect ECONNREFUSED 1.2.3.4:25565',
    lastErrorHint: 'Check the hostname/port.'
  })

  await waitFor(() => ui.$('#phasePill').dataset.phase === 'reconnecting', { label: 'reconnecting pill' })
  assert.match(ui.$('#phaseText').textContent, /reconnecting/)
  assert.equal(ui.$('#banner').hidden, false)
  assert.match(ui.$('#bannerText').textContent, /ECONNREFUSED/)
  assert.match(ui.$('#bannerHint').textContent, /hostname\/port/)

  ui.$('#bannerClose').click()
  assert.equal(ui.$('#banner').hidden, true)
})
