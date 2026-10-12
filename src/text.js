'use strict'

/**
 * Helpers for turning Minecraft chat packets into something a browser can show.
 *
 * Every function here is defensive: a malformed component from a custom server
 * plugin must never take the bot down.
 */

const USERNAME = '[A-Za-z0-9_]{1,16}'
const VANILLA_CHAT = new RegExp(`^<(${USERNAME})>\\s?([\\s\\S]*)$`)
const WHISPER_IN = 'commands.message.display.incoming'
const WHISPER_OUT = 'commands.message.display.outgoing'
const DEATH_KEYS = ['death.', 'multiplayer.player.joined', 'multiplayer.player.left']

/** Plain text of a raw chat component (string | object | array). */
function componentText (component) {
  if (component === null || component === undefined) return ''
  if (typeof component === 'string') return component
  if (typeof component === 'number' || typeof component === 'boolean') return String(component)
  if (Array.isArray(component)) return component.map(componentText).join('')
  if (typeof component === 'object') {
    let out = ''
    if (component.text !== undefined) out += componentText(component.text)
    if (component.translate !== undefined && component.with === undefined) out += String(component.translate)
    if (Array.isArray(component.with)) out += componentText(component.with)
    if (Array.isArray(component.extra)) out += component.extra.map(componentText).join('')
    if (component.content !== undefined) out += componentText(component.content)
    return out
  }
  return String(component)
}

const safe = (fn, fallback = '') => {
  try {
    const v = fn()
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

/** `jsonMsg.toString()` but never throws. */
const plain = (jsonMsg) => safe(() => (typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : String(jsonMsg)))

/** `jsonMsg.toMotd()` (text with § colour codes) but never throws. */
const motd = (jsonMsg) => {
  const out = safe(() => (typeof jsonMsg?.toMotd === 'function' ? jsonMsg.toMotd() : null), null)
  return out && typeof out === 'string' ? out : null
}

/** Remove § codes from a string. */
const stripColors = (str) => String(str ?? '').replace(/§[0-9a-fk-or]/gi, '')

/**
 * Pull the speaker out of a chat line.
 * Works with vanilla 1.7-1.18 ("<name> hi"), 1.19+ client-side chat formatting
 * (translate + with[sender, content]) and whispers.
 *
 * @returns {{author: string|null, body: string, kind: 'chat'|'whisper'|'system'|'actionbar'}}
 */
function parseSpeaker (jsonMsg, { position = 'chat', customPattern = null } = {}) {
  const text = plain(jsonMsg)
  const json = (jsonMsg && jsonMsg.json) || null

  const base = {
    author: null,
    body: text,
    kind: position === 'game_info' ? 'actionbar' : position === 'chat' ? 'chat' : 'system'
  }

  if (!json) return base

  // /tell and /msg
  if (json.translate === WHISPER_IN || json.translate === WHISPER_OUT) {
    const who = Array.isArray(json.with) ? componentText(json.with[0]).trim() : null
    const what = Array.isArray(json.with) ? componentText(json.with[1]).trim() : text
    return { author: who || null, body: what || text, kind: 'whisper' }
  }

  // 1.19+ : { translate: '<%s> %s', with: [ {text:'name'}, content ] }
  if (typeof json.translate === 'string' && Array.isArray(json.with) && json.with.length >= 2) {
    const fmt = json.translate
    if (/^<?%s>?\s%s$/.test(fmt) || fmt === 'chat.type.text' || fmt === 'chat.type.announcement') {
      const author = componentText(json.with[0]).trim()
      const body = componentText(json.with.slice(1)).trim()
      if (author) return { author, body: body || text, kind: 'chat' }
    }
  }

  // Server-specific pattern, e.g. CHAT_AUTHOR_PATTERN='^\[(?:\w+)\]\s(\w+)\s»\s(.*)$'
  if (customPattern) {
    try {
      const m = new RegExp(customPattern).exec(text)
      if (m && m[1]) {
        return { author: m[1], body: m[2] !== undefined ? m[2] : text, kind: 'chat' }
      }
    } catch {
      /* bad regex in env — ignore */
    }
  }

  // Classic "<name> message"
  const m = VANILLA_CHAT.exec(text)
  if (m) return { author: m[1], body: m[2], kind: base.kind === 'chat' ? 'chat' : base.kind }

  // Join/leave/death translations -> their own kind so the UI can group them
  if (typeof json.translate === 'string' && DEATH_KEYS.some((k) => json.translate.startsWith(k))) {
    return { ...base, kind: 'player' }
  }

  return base
}

/** Messages that mean "this server is NOT in offline mode". */
const ONLINE_MODE_RE =
  /failed to verify username|exception connecting to server|invalid session|authentication (?:servers|failed)|you are not logged in|not authenticated|premium account required|log in to minecraft|failed to log in|incompatible client|verify your account/i

/** Messages that mean "wrong/unsupported server version". */
const VERSION_RE = /outdated (?:client|server)|unsupported (?:game )?version|protocol version|please use minecraft/i

/** Kick/disconnect reasons -> a human explanation shown in the UI. */
function explainFailure (raw) {
  const text = stripColors(typeof raw === 'string' ? raw : plain(raw))
  if (!text) return null
  if (ONLINE_MODE_RE.test(text)) {
    return {
      code: 'online_mode',
      message: text,
      hint:
        'The server rejected the offline/cracked login. It is running with online-mode=true, so a real ' +
        'Microsoft account is required. Either set online-mode=false in server.properties (plus an auth ' +
        'plugin), or set MC_AUTH=microsoft in .env and run `npm run login:microsoft`.'
    }
  }
  if (VERSION_RE.test(text)) {
    return {
      code: 'version',
      message: text,
      hint:
        'Version mismatch. Mineflayer supports 1.8 - 1.21.x. Set MC_VERSION explicitly in .env (e.g. 1.20.4), ' +
        'and remember mineflayer cannot join servers running only newer snapshot/bedrock protocols.'
    }
  }
  if (/timed? ?out|connect ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|socket closed/i.test(text)) {
    return {
      code: 'network',
      message: text,
      hint:
        'Could not reach the server. Check the hostname/port, that the server is up, and that the VM has ' +
        'outbound TCP access to it.'
    }
  }
  if (/too many|spam|slow ?down|rate ?limit|too fast|sending .* too quickly/i.test(text)) {
    return { code: 'rate_limited', message: text, hint: 'You are sending chat too fast. Raise SEND_COOLDOWN_MS.' }
  }
  return { code: 'other', message: text, hint: null }
}

/** Vec3-ish -> "x, y, z" rounded. */
function formatPosition (pos) {
  if (!pos || typeof pos.x !== 'number') return null
  return { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
}

module.exports = {
  componentText,
  plain,
  motd,
  stripColors,
  parseSpeaker,
  explainFailure,
  formatPosition,
  VANILLA_CHAT
}
