/* ────────────────────────────────────────────────────────────────────────────
   Live Minecraft chat bridge — dashboard client
   Connects to the Node bridge over WebSocket, renders coloured chat, and lets
   you talk back through the bot.
   ──────────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict'

  const CFG = Object.assign(
    { gateway: '', wsPath: '/ws', apiBase: '/api', title: '', fallbackBotName: 'bot', autoToken: '' },
    window.BOT_BRIDGE_CONFIG || {}
  )

  const GATEWAY = (CFG.gateway || window.location.origin).replace(/\/+$/, '')
  const WS_URL = GATEWAY.replace(/^http/, 'ws') + CFG.wsPath
  const API = GATEWAY + CFG.apiBase

  const $ = (id) => document.getElementById(id)
  const el = {
    botName: $('botName'), serverLabel: $('serverLabel'),
    phasePill: $('phasePill'), phaseText: $('phaseText'),
    socketPill: $('socketPill'), socketText: $('socketText'),
    playersPill: $('playersPill'), playersCount: $('playersCount'),
    banner: $('banner'), bannerTitle: $('bannerTitle'), bannerText: $('bannerText'), bannerHint: $('bannerHint'),
    feed: $('feed'), empty: $('empty'), emptyHint: $('emptyHint'),
    btnJump: $('btnJump'), jumpCount: $('jumpCount'),
    search: $('search'), composer: $('composer'), input: $('input'), btnSend: $('btnSend'),
    composerAs: $('composerAs'), charCount: $('charCount'), authState: $('authState'),
    btnAutoScroll: $('btnAutoScroll'), btnClear: $('btnClear'),
    motd: $('motd'), srvAddress: $('srvAddress'), srvVersion: $('srvVersion'), srvPlayers: $('srvPlayers'),
    srvAuth: $('srvAuth'), srvUptime: $('srvUptime'),
    switcherWrap: $('switcherWrap'), serverSelect: $('serverSelect'), btnSwitch: $('btnSwitch'),
    healthBar: $('healthBar'), healthVal: $('healthVal'), foodBar: $('foodBar'), foodVal: $('foodVal'),
    botPos: $('botPos'), botDim: $('botDim'), botTime: $('botTime'),
    btnReconnect: $('btnReconnect'), btnExport: $('btnExport'),
    playerList: $('playerList'), playersEmpty: $('playersEmpty'), sidePlayerCount: $('sidePlayerCount'),
    statReceived: $('statReceived'), statSent: $('statSent'), statGateway: $('statGateway'),
    settingsModal: $('settingsModal'), btnSettings: $('btnSettings'), btnSettingsClose: $('btnSettingsClose'),
    tokenInput: $('tokenInput'), nickInput: $('nickInput'), btnSaveSettings: $('btnSaveSettings'), btnTestToken: $('btnTestToken'),
    optSound: $('optSound'), optTimestamps: $('optTimestamps'), optCompact: $('optCompact'), optLight: $('optLight'),
    optActionBar: $('optActionBar'),
    toasts: $('toasts'), sidebar: $('sidebar'), btnSidebar: $('btnSidebar'), quick: $('quick')
  }

  /* ───────────────────────────── preferences ───────────────────────────── */

  const PREF_KEY = 'mc-bridge-prefs-v1'
  const prefs = Object.assign(
    { token: CFG.autoToken || '', nick: '', sound: false, timestamps: true, compact: false, light: false, actionBar: false, filter: 'all', autoscroll: true },
    loadJSON(PREF_KEY, {})
  )

  function loadJSON (key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || '') || fallback
    } catch {
      return fallback
    }
  }
  const savePrefs = () => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
    } catch { /* private mode */ }
  }

  function applyPrefs () {
    document.body.dataset.theme = prefs.light ? 'light' : 'dark'
    document.body.dataset.compact = prefs.compact ? '1' : '0'
    document.body.dataset.timestamps = prefs.timestamps ? '1' : '0'
    el.optSound.checked = !!prefs.sound
    el.optTimestamps.checked = prefs.timestamps !== false
    el.optCompact.checked = !!prefs.compact
    el.optLight.checked = !!prefs.light
    el.optActionBar.checked = !!prefs.actionBar
    el.tokenInput.value = prefs.token || ''
    el.nickInput.value = prefs.nick || ''
    el.btnAutoScroll.setAttribute('aria-pressed', String(!!prefs.autoscroll))
    el.btnAutoScroll.classList.toggle('is-active', !!prefs.autoscroll)
    setActiveFilter(prefs.filter || 'all', false)
  }

  /* ─────────────────────── Minecraft colour rendering ─────────────────── */

  const MC_COLORS = {
    0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA',
    6: '#FFAA00', 7: '#AAAAAA', 8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF',
    c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF'
  }
  // Near-black colours are unreadable on the dark theme.
  const DARK_FIX = { '#000000': '#4a5560', '#555555': '#8b9aa8', '#0000AA': '#4a6fd4' }
  const STYLE_KEYS = { l: 'bold', m: 'strike', n: 'underline', o: 'italic', k: 'obf' }

  /** Split "§ahello §lworld" into styled segments. */
  function motdSegments (input) {
    const str = String(input == null ? '' : input)
    const segs = []
    const blank = () => ({ text: '', color: null, bold: false, italic: false, underline: false, strike: false, obf: false })
    let cur = blank()
    const flush = () => {
      if (cur.text) segs.push(cur)
      const styles = { color: cur.color, bold: cur.bold, italic: cur.italic, underline: cur.underline, strike: cur.strike, obf: cur.obf }
      cur = Object.assign(blank(), styles)
    }

    const chars = Array.from(str)
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if ((c === '§' || c === '&') && i + 1 < chars.length) {
        const code = chars[++i].toLowerCase()
        if (MC_COLORS[code]) { flush(); cur.color = MC_COLORS[code]; continue }
        if (code === 'r') { flush(); cur = blank(); continue }
        if (STYLE_KEYS[code]) { flush(); cur[STYLE_KEYS[code]] = true; continue }
        if (code === 'x') {
          let hex = ''
          let j = i + 1
          while (hex.length < 6 && j + 1 < chars.length && (chars[j] === '§' || chars[j] === '&')) {
            hex += chars[j + 1].toLowerCase()
            j += 2
          }
          if (hex.length === 6 && /^[0-9a-f]{6}$/.test(hex)) { flush(); cur.color = '#' + hex; i = j - 1; continue }
          continue
        }
        continue // unknown code: drop it
      }
      cur.text += c
    }
    flush()
    return segs
  }

  /** Render text into a node using textContent only — chat can never inject HTML. */
  function paint (node, text, motdText) {
    node.textContent = ''
    const source = motdText && motdText.length ? motdText : text
    const segs = motdSegments(source)
    const dark = !prefs.light
    if (!segs.length) {
      node.appendChild(document.createTextNode(text || ''))
      return
    }
    for (const seg of segs) {
      const span = document.createElement('span')
      span.textContent = seg.text
      let color = seg.color
      if (color && dark && DARK_FIX[color.toUpperCase()]) color = DARK_FIX[color.toUpperCase()]
      if (color) span.style.color = color
      if (seg.bold) span.style.fontWeight = '800'
      if (seg.italic) span.style.fontStyle = 'italic'
      const deco = []
      if (seg.underline) deco.push('underline')
      if (seg.strike) deco.push('line-through')
      if (deco.length) span.style.textDecoration = deco.join(' ')
      if (seg.obf) span.style.opacity = '.6'
      node.appendChild(span)
    }
  }

  /* ───────────────────────────── feed / state ─────────────────────────── */

  const MAX_ROWS = 1200
  const messages = [] // every record we know about (bounded)
  let lastId = 0
  let state = { phase: 'idle', online: false, username: CFG.fallbackBotName, servers: [], players: [], counters: {} }
  let authenticated = false
  let anonymousChat = false
  let allowServerSwitch = false
  let unread = 0
  let atBottom = true
  let searchTerm = ''
  let activeFilter = 'all'

  const fmtTime = (ts) => {
    const d = new Date(ts || Date.now())
    return d.toTimeString().slice(0, 8)
  }

  function keep (record) {
    messages.push(record)
    if (record.id > lastId) lastId = record.id
    if (messages.length > MAX_ROWS) messages.splice(0, messages.length - MAX_ROWS)
  }

  function matches (m) {
    if (m.kind === 'actionbar' && !prefs.actionBar) return false
    if (activeFilter !== 'all') {
      if (activeFilter === 'bot' && m.kind !== 'bot') return false
      if (activeFilter === 'chat' && m.kind !== 'chat') return false
      if (activeFilter === 'system' && !(m.kind === 'system' || m.kind === 'status')) return false
      if (activeFilter === 'player' && m.kind !== 'player') return false
      if (activeFilter === 'whisper' && m.kind !== 'whisper') return false
    }
    if (searchTerm) {
      const hay = `${m.author || ''} ${m.text || ''}`.toLowerCase()
      if (!hay.includes(searchTerm)) return false
    }
    return true
  }

  function buildRow (m) {
    const row = document.createElement('div')
    row.className = 'row'
    row.dataset.kind = m.kind || 'system'
    row.dataset.id = m.id
    if (m.meta && m.meta.pending) row.classList.add('is-pending')
    if (m.meta && m.meta.source === 'web') row.classList.add('is-own')

    const ts = document.createElement('span')
    ts.className = 'ts'
    ts.textContent = fmtTime(m.ts)
    ts.title = new Date(m.ts).toLocaleString()
    row.appendChild(ts)

    if (m.author) {
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = m.author
      who.style.color = colorFor(m.author)
      who.title = `Message ${m.author}`
      who.addEventListener('click', () => insertAtInput(`/msg ${m.author} `))
      row.appendChild(who)
    } else if (m.kind === 'status' || m.kind === 'system' || m.kind === 'whisper' || m.kind === 'actionbar') {
      const badge = document.createElement('span')
      badge.className = 'kind-badge'
      badge.textContent = m.kind === 'status' ? 'bridge' : m.kind
      row.appendChild(badge)
    }

    const body = document.createElement('span')
    body.className = 'body'
    paint(body, m.text, m.motd)
    row.appendChild(body)

    row.title = m.text || ''
    return row
  }

  /** Stable colour per player name so the feed is easy to scan. */
  const nameColors = {}
  const PALETTE = ['#5ad1a5', '#7fb3ff', '#f2b45c', '#e78fb3', '#b49cff', '#7fd6e8', '#c7e07a', '#ff9c7f', '#d9d16a', '#8fe0c0']
  function colorFor (name) {
    if (!nameColors[name]) {
      let h = 0
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
      nameColors[name] = PALETTE[h % PALETTE.length]
    }
    return nameColors[name]
  }

  function appendRow (m) {
    if (!matches(m)) return
    el.feed.appendChild(buildRow(m))
    while (el.feed.childElementCount > MAX_ROWS) el.feed.removeChild(el.feed.firstChild)
    el.empty.hidden = el.feed.childElementCount > 0
    if (atBottom && prefs.autoscroll) scrollToBottom()
    else if (!atBottom) {
      unread++
      el.jumpCount.textContent = unread
      el.btnJump.hidden = false
    }
  }

  function rerender () {
    el.feed.textContent = ''
    const visible = messages.filter(matches).slice(-MAX_ROWS)
    const frag = document.createDocumentFragment()
    for (const m of visible) frag.appendChild(buildRow(m))
    el.feed.appendChild(frag)
    el.empty.hidden = visible.length > 0
    if (atBottom) scrollToBottom()
  }

  function scrollToBottom () {
    el.feed.scrollTop = el.feed.scrollHeight
    unread = 0
    el.btnJump.hidden = true
  }

  el.feed.addEventListener('scroll', () => {
    const distance = el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight
    atBottom = distance < 60
    if (atBottom) {
      unread = 0
      el.btnJump.hidden = true
    }
  })
  el.btnJump.addEventListener('click', scrollToBottom)

  function setActiveFilter (filter, rerenderNow = true) {
    activeFilter = filter
    prefs.filter = filter
    savePrefs()
    document.querySelectorAll('.filters .chip').forEach((chip) => {
      const on = chip.dataset.filter === filter
      chip.classList.toggle('is-active', on)
      chip.setAttribute('aria-selected', String(on))
    })
    if (rerenderNow) rerender()
  }

  document.querySelectorAll('.filters .chip').forEach((chip) =>
    chip.addEventListener('click', () => setActiveFilter(chip.dataset.filter))
  )

  let searchTimer = null
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchTerm = el.search.value.trim().toLowerCase()
      rerender()
    }, 140)
  })

  el.btnAutoScroll.addEventListener('click', () => {
    prefs.autoscroll = !prefs.autoscroll
    savePrefs()
    el.btnAutoScroll.setAttribute('aria-pressed', String(prefs.autoscroll))
    toast(prefs.autoscroll ? 'Auto-scroll on' : 'Auto-scroll off — new lines stay put')
    if (prefs.autoscroll) scrollToBottom()
  })

  el.btnClear.addEventListener('click', () => {
    messages.length = 0
    lastId = 0
    rerender()
    toast('Local feed cleared (the server log is untouched)')
  })

  /* ───────────────────────────── state rendering ───────────────────────── */

  const PHASE_LABEL = {
    idle: 'idle', connecting: 'connecting', online: 'online',
    reconnecting: 'reconnecting', stopped: 'stopped', error: 'error'
  }

  function renderState (next) {
    state = Object.assign({}, state, next || {})
    const s = state

    document.title = `${s.username || CFG.fallbackBotName} · ${s.server ? s.server.label : 'no server'} · live`
    el.botName.textContent = s.username || CFG.fallbackBotName
    el.composerAs.textContent = s.username || CFG.fallbackBotName
    el.serverLabel.textContent = s.server ? `${s.server.label}${s.version ? ' · ' + s.version : ''}` : 'no server'

    el.phasePill.dataset.phase = s.phase || 'idle'
    el.phaseText.textContent = PHASE_LABEL[s.phase] || s.phase || 'idle'

    // Server card
    const info = s.serverInfo || null
    if (info && (info.motd || info.motdColored)) {
      paint(el.motd, info.motd || '', info.motdColored || info.motd)
    } else {
      el.motd.textContent = s.server ? s.server.label : '—'
    }
    el.srvAddress.textContent = s.server ? `${s.server.host}:${s.server.port}` : '—'
    el.srvVersion.textContent = info?.version || s.version || '—'
    el.srvPlayers.textContent = info && info.max ? `${info.online ?? '?'}/${info.max}` : `${s.playerCount || 0}`
    el.srvAuth.textContent = s.auth === 'microsoft' ? 'premium (Microsoft)' : 'offline / cracked'
    el.playersCount.textContent = s.playerCount || 0
    el.sidePlayerCount.textContent = s.playerCount || 0

    // Vitals
    const health = typeof s.health === 'number' ? s.health : null
    const food = typeof s.food === 'number' ? s.food : null
    el.healthBar.style.width = health == null ? '0%' : `${Math.max(0, Math.min(100, (health / 20) * 100))}%`
    el.healthVal.textContent = health == null ? '—' : `${health}/20`
    el.foodBar.style.width = food == null ? '0%' : `${Math.max(0, Math.min(100, (food / 20) * 100))}%`
    el.foodVal.textContent = food == null ? '—' : `${food}/20`
    el.botPos.textContent = s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '—'
    el.botDim.textContent = s.dimension ? String(s.dimension).replace('minecraft:', '') : '—'
    el.botTime.textContent = s.time ? `day ${s.time.day} · ${s.time.clock}` : '—'

    // Counters
    el.statReceived.textContent = s.counters?.received ?? 0
    el.statSent.textContent = s.counters?.sent ?? 0

    renderPlayers(s.players || [])
    renderServerSwitcher(s)
    renderBanner(s)
    updateComposer()
  }

  function renderPlayers (players) {
    el.playerList.textContent = ''
    if (!players.length) {
      el.playersEmpty.hidden = false
      return
    }
    el.playersEmpty.hidden = true
    const frag = document.createDocumentFragment()
    for (const p of players) {
      const li = document.createElement('li')
      if (p.isSelf) li.classList.add('is-self')
      li.title = `Message ${p.username}`
      const name = document.createElement('span')
      name.className = 'pname'
      name.textContent = p.display || p.username
      name.style.color = p.isSelf ? '' : colorFor(p.username)
      li.appendChild(name)
      const ping = document.createElement('span')
      ping.className = 'ping'
      if (typeof p.ping === 'number') {
        ping.textContent = `${p.ping}ms`
        ping.dataset.q = p.ping < 80 ? 'good' : p.ping < 180 ? 'mid' : 'bad'
      } else {
        ping.textContent = p.gamemode || ''
      }
      li.appendChild(ping)
      li.addEventListener('click', () => insertAtInput(`/msg ${p.username} `))
      frag.appendChild(li)
    }
    el.playerList.appendChild(frag)
  }

  function renderServerSwitcher (s) {
    const servers = s.servers || []
    el.switcherWrap.hidden = !allowServerSwitch || servers.length < 2
    if (el.switcherWrap.hidden) return
    const current = s.server ? s.server.label : ''
    if (el.serverSelect.options.length !== servers.length || el.serverSelect.dataset.loaded !== '1') {
      el.serverSelect.textContent = ''
      for (const srv of servers) {
        const opt = document.createElement('option')
        opt.value = srv.label
        opt.textContent = srv.label
        el.serverSelect.appendChild(opt)
      }
      el.serverSelect.dataset.loaded = '1'
    }
    el.serverSelect.value = current
  }

  let bannerDismissed = ''
  function renderBanner (s) {
    const key = s.lastError || s.lastKick || ''
    if (!key || bannerDismissed === key) {
      el.banner.hidden = true
      return
    }
    el.banner.hidden = false
    el.banner.dataset.kind = s.phase === 'error' ? 'error' : 'warn'
    el.bannerTitle.textContent = s.phase === 'reconnecting' ? `Reconnecting (attempt ${s.attempts || 1})` : 'Connection problem'
    el.bannerText.textContent = key
    const hint = s.lastErrorHint || null
    el.bannerHint.hidden = !hint
    if (hint) el.bannerHint.textContent = hint
  }
  $('bannerClose').addEventListener('click', () => {
    bannerDismissed = state.lastError || state.lastKick || ''
    el.banner.hidden = true
  })

  /* ──────────────────────────── composer logic ─────────────────────────── */

  function updateComposer () {
    const canSend = authenticated && socket && socket.readyState === WebSocket.OPEN
    el.input.disabled = !canSend
    el.btnSend.disabled = !canSend || !el.input.value.trim()
    el.authState.dataset.ok = authenticated ? '1' : '0'
    el.authState.textContent = anonymousChat
      ? 'open chat'
      : authenticated
        ? 'token ok'
        : 'token needed — ⚙ Settings'
    if (state.phase !== 'online' && authenticated) {
      el.input.placeholder = `Bot is ${state.phase} — you can queue a message, it sends once it is back`
    } else {
      el.input.placeholder = 'Say something on the server…  ( / commands work too )'
    }
  }

  function insertAtInput (text) {
    el.input.value = text
    el.input.focus()
    el.charCount.textContent = String(text.length)
    updateComposer()
  }

  el.input.addEventListener('input', () => {
    el.charCount.textContent = String(el.input.value.length)
    updateComposer()
  })

  el.composer.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const text = el.input.value.trim()
    if (!text) return
    if (!authenticated) {
      openSettings()
      toast('Enter your chat token first', 'warn')
      return
    }
    sendChat(text)
  })

  el.quick.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-cmd]')
    if (!btn) return
    insertAtInput(btn.dataset.cmd)
  })

  function sendChat (text) {
    const id = 'c' + Math.random().toString(36).slice(2, 9)
    pending.set(id, text)
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'chat', text, token: prefs.token || undefined, id }))
    } else {
      void httpSend(text, id)
    }
    el.input.value = ''
    el.charCount.textContent = '0'
    updateComposer()
  }

  /** Fallback path when the socket is down (e.g. proxy without WS support). */
  async function httpSend (text, id) {
    try {
      const res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Token': prefs.token || '' },
        body: JSON.stringify({ text, token: prefs.token || '' })
      })
      const data = await res.json().catch(() => ({}))
      handleAck({ id, ok: !!data.ok, error: data.error })
    } catch (err) {
      handleAck({ id, ok: false, error: err?.message || 'Network error' })
    }
  }

  const pending = new Map()
  function handleAck (ack) {
    const text = pending.get(ack.id)
    pending.delete(ack.id)
    if (ack.ok) {
      blip(880, 0.04)
      return
    }
    toast(ack.error || 'Message rejected', 'error')
    if (text && /token|authoriz/i.test(ack.error || '')) {
      openSettings()
    } else if (text) {
      el.input.value = text // put it back so nothing is lost
      el.charCount.textContent = String(text.length)
      updateComposer()
      el.input.focus()
    }
  }

  /* ────────────────────────────── websocket ─────────────────────────────── */

  let socket = null
  let attempt = 0
  let reconnectTimer = null

  function setSocketState (s, label) {
    el.socketPill.dataset.state = s
    el.socketText.textContent = label || s
  }

  function connect () {
    clearTimeout(reconnectTimer)
    setSocketState('connecting', 'connecting')
    let ws
    try {
      ws = new WebSocket(WS_URL + (prefs.token ? `?token=${encodeURIComponent(prefs.token)}` : ''))
    } catch (err) {
      toast('Cannot open websocket: ' + err.message, 'error')
      scheduleReconnect()
      return
    }
    socket = ws

    ws.addEventListener('open', () => {
      attempt = 0
      setSocketState('open', 'live')
      if (prefs.token) ws.send(JSON.stringify({ type: 'auth', token: prefs.token }))
      if (lastId) ws.send(JSON.stringify({ type: 'sync', since: lastId }))
      updateComposer()
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'hello':
          authenticated = !!(msg.you && msg.you.authenticated)
          anonymousChat = !!(msg.you && msg.you.anonymousChat)
          if (!messages.length && Array.isArray(msg.messages)) {
            for (const m of msg.messages) keep(m)
            rerender()
          }
          lastId = msg.lastId || lastId
          renderState(msg.state)
          break
        case 'state':
          renderState(msg.state)
          break
        case 'message': {
          const m = msg.message
          keep(m)
          if (m.kind !== 'bot' || !(m.meta && m.meta.source === 'web')) blipFor(m)
          appendRow(m)
          if (msg.counters) {
            state.counters = msg.counters
            el.statReceived.textContent = String(msg.counters.received ?? 0)
            el.statSent.textContent = String(msg.counters.sent ?? 0)
          }
          break
        }
        case 'sync':
          for (const m of msg.messages || []) {
            if (!messages.some((x) => x.id === m.id)) { keep(m); appendRow(m) }
          }
          break
        case 'auth':
          authenticated = !!msg.ok
          if (!msg.ok) toast(msg.message || 'Token rejected', 'error')
          updateComposer()
          break
        case 'ack':
          handleAck(msg)
          break
        case 'cleared':
          messages.length = 0
          rerender()
          break
        case 'pong':
          break
        case 'error':
          if (msg.code === 'bad_origin') {
            setBanner('error', 'Browser blocked', 'This page origin is not allowed. Add it to ALLOWED_ORIGINS in the VM .env.', null)
          } else {
            toast(msg.message || 'Socket error', 'error')
          }
          break
        default:
          break
      }
    })

    ws.addEventListener('close', (ev) => {
      setSocketState('closed', ev.code === 4003 ? 'origin blocked' : 'offline')
      socket = null
      updateComposer()
      scheduleReconnect()
    })

    ws.addEventListener('error', () => setSocketState('closed', 'error'))
  }

  function scheduleReconnect () {
    attempt++
    const delay = Math.min(30000, 1000 * Math.pow(1.7, attempt - 1))
    setSocketState('connecting', `retry ${Math.round(delay / 1000)}s`)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, delay)
  }

  function setBanner (kind, title, text, hint) {
    el.banner.hidden = false
    el.banner.dataset.kind = kind
    el.bannerTitle.textContent = title
    el.bannerText.textContent = text
    el.bannerHint.hidden = !hint
    if (hint) el.bannerHint.textContent = hint
    bannerDismissed = ''
  }

  /* ──────────────────────────────── sounds ──────────────────────────────── */

  let audioCtx = null
  function blip (freq = 660, dur = 0.05, gain = 0.03) {
    if (!prefs.sound) return
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
      const osc = audioCtx.createOscillator()
      const amp = audioCtx.createGain()
      osc.type = 'square'
      osc.frequency.value = freq
      amp.gain.value = gain
      osc.connect(amp).connect(audioCtx.destination)
      osc.start()
      amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur)
      osc.stop(audioCtx.currentTime + dur + 0.02)
    } catch { /* no audio */ }
  }
  const blipFor = (m) => {
    if (m.kind === 'chat' || m.kind === 'whisper') blip(m.kind === 'whisper' ? 740 : 620, 0.05)
  }

  /* ──────────────────────────────── toasts ──────────────────────────────── */

  function toast (text, kind = 'info', ms = 3800) {
    const t = document.createElement('div')
    t.className = 'toast'
    t.dataset.kind = kind
    t.textContent = text
    el.toasts.appendChild(t)
    setTimeout(() => {
      t.style.opacity = '0'
      t.style.transition = 'opacity .25s'
      setTimeout(() => t.remove(), 260)
    }, ms)
    while (el.toasts.childElementCount > 4) el.toasts.removeChild(el.toasts.firstChild)
  }

  /* ─────────────────────────────── actions ─────────────────────────────── */

  function wsSend (payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(Object.assign({ token: prefs.token || undefined }, payload)))
      return true
    }
    return false
  }

  async function api (path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Chat-Token': prefs.token || '' },
      body: JSON.stringify(Object.assign({ token: prefs.token || '' }, body || {}))
    })
    return res.json().catch(() => ({ ok: false, error: 'Bad response' }))
  }

  el.btnReconnect.addEventListener('click', async () => {
    if (!authenticated) return toast('Token needed for that', 'warn')
    const ok = wsSend({ type: 'action', action: 'reconnect', id: 'a1' })
    if (!ok) {
      const r = await api('/action', { action: 'reconnect' })
      toast(r.ok ? 'Reconnecting…' : r.error || 'Failed', r.ok ? 'info' : 'error')
    } else {
      toast('Reconnecting…')
    }
  })

  el.btnSwitch.addEventListener('click', async () => {
    const label = el.serverSelect.value
    if (!label) return
    if (!authenticated) return toast('Token needed for that', 'warn')
    if (!wsSend({ type: 'switch', label, id: 's1' })) {
      const r = await api('/server', { label })
      toast(r.ok ? `Switching to ${label}` : r.error || 'Failed', r.ok ? 'info' : 'error')
    } else {
      toast(`Switching to ${label}…`)
    }
  })

  el.btnExport.addEventListener('click', () => {
    const lines = messages.filter(matches).map((m) =>
      `[${new Date(m.ts).toISOString()}] ${m.author ? `<${m.author}> ` : `(${m.kind}) `}${m.text}`
    )
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `chat-${(state.server ? state.server.host : 'server')}-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    toast(`Exported ${lines.length} lines`)
  })

  /* ─────────────────────────────── settings ─────────────────────────────── */

  function openSettings () {
    el.tokenInput.value = prefs.token || ''
    el.nickInput.value = prefs.nick || ''
    el.settingsModal.hidden = false
    setTimeout(() => el.tokenInput.focus(), 40)
  }
  function closeSettings () {
    el.settingsModal.hidden = true
  }

  el.btnSettings.addEventListener('click', openSettings)
  el.btnSettingsClose.addEventListener('click', closeSettings)
  el.settingsModal.addEventListener('click', (ev) => {
    if (ev.target === el.settingsModal) closeSettings()
  })

  el.btnSaveSettings.addEventListener('click', () => {
    prefs.token = el.tokenInput.value.trim()
    prefs.nick = el.nickInput.value.trim()
    prefs.sound = el.optSound.checked
    prefs.timestamps = el.optTimestamps.checked
    prefs.compact = el.optCompact.checked
    prefs.light = el.optLight.checked
    prefs.actionBar = el.optActionBar.checked
    savePrefs()
    applyPrefs()
    rerender()
    closeSettings()
    // Re-handshake with the new token.
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'auth', token: prefs.token }))
    } else {
      connect()
    }
    toast('Settings saved')
  })

  el.btnTestToken.addEventListener('click', async () => {
    prefs.token = el.tokenInput.value.trim()
    savePrefs()
    try {
      const res = await fetch(API + '/verify?token=' + encodeURIComponent(prefs.token))
      const data = await res.json()
      if (data.authorized) {
        toast('Token accepted ✓')
        authenticated = true
        updateComposer()
      } else {
        toast(data.anonymous ? 'Anonymous chat is enabled — no token needed' : 'Token rejected', data.anonymous ? 'info' : 'error')
      }
    } catch (err) {
      toast('Cannot reach ' + API + ' — ' + err.message, 'error')
    }
  })

  /* ───────────────────────── sidebar / shortcuts ───────────────────────── */

  el.btnSidebar.addEventListener('click', () => {
    const hidden = el.sidebar.hasAttribute('hidden')
    if (hidden) el.sidebar.removeAttribute('hidden')
    else el.sidebar.setAttribute('hidden', '')
    el.btnSidebar.setAttribute('aria-expanded', String(hidden))
  })
  if (window.matchMedia('(max-width: 940px)').matches) el.sidebar.setAttribute('hidden', '')

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.settingsModal.hidden) return closeSettings()
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '')
    if (!typing && ev.key === '/' && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault()
      insertAtInput('/')
    }
    if (!typing && (ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault()
      el.search.focus()
    }
  })

  /* ────────────────────────────── bootstrap ─────────────────────────────── */

  async function loadConfig () {
    try {
      const res = await fetch(API + '/config')
      const data = await res.json()
      if (!data.ok) return
      anonymousChat = !!data.anonymousChat
      allowServerSwitch = !!data.allowServerSwitch
      if (data.bot?.username) {
        el.botName.textContent = data.bot.username
        el.composerAs.textContent = data.bot.username
      }
      el.statGateway.textContent = GATEWAY
      if (anonymousChat) authenticated = true
    } catch {
      el.statGateway.textContent = GATEWAY + ' (unreachable)'
    }
  }

  async function loadState () {
    try {
      const res = await fetch(API + '/state')
      const data = await res.json()
      if (data.ok) renderState(data.state)
    } catch { /* socket will fill it in */ }
  }

  function startClock () {
    setInterval(() => {
      if (!state.connectedAt) {
        el.srvUptime.textContent = state.runtimeMs ? `${fmtDuration(state.runtimeMs)} (offline)` : '—'
        return
      }
      el.srvUptime.textContent = fmtDuration(Date.now() - state.connectedAt)
    }, 1000)
  }
  function fmtDuration (ms) {
    const s = Math.floor(ms / 1000)
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d) return `${d}d ${h}h`
    if (h) return `${h}h ${m}m`
    if (m) return `${m}m ${s % 60}s`
    return `${s}s`
  }

  // Re-check liveness even when the socket is wedged behind a proxy.
  setInterval(() => {
    fetch(API.replace('/api', '/healthz'))
      .then((r) => r.json())
      .then((d) => {
        if (d && d.phase && d.phase !== state.phase) renderState({ phase: d.phase, online: !!d.online })
      })
      .catch(() => {})
  }, 15000)

  applyPrefs()
  el.statGateway.textContent = GATEWAY
  renderState({})
  startClock()
  loadConfig().then(() => {
    loadState().then(connect)
  })
  window.addEventListener('online', connect)
})()
