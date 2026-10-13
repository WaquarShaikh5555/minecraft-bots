'use strict'

/**
 * Central configuration. Everything comes from environment variables (or a
 * .env file) so the same code runs on a laptop, a Docker box and an Azure VM.
 */

const path = require('path')
const crypto = require('crypto')
const fs = require('fs')

// Load .env if present (dotenv never overrides real environment variables).
// Skipped under NODE_ENV=test so a developer's local .env cannot change tests.
if (process.env.NODE_ENV !== 'test') {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
  } catch {
    /* dotenv is optional at runtime */
  }
}

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/** "world.arterex.me:25565, play.foo.net" -> [{host, port, label}, ...] */
function parseServers (raw, fallbackHost) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      // Supports "host", "host:port" and "srv://host:port"
      const cleaned = entry.replace(/^srv:\/\/|https?:\/\//i, '')
      const [host, portPart] = cleaned.split(':')
      const port = int(portPart, 25565)
      return {
        host: host.trim(),
        port,
        label: cleaned
      }
    })
  if (!list.length && fallbackHost) list.push({ host: fallbackHost, port: 25565, label: fallbackHost })
  return list
}

const USERNAME = (process.env.MC_USERNAME || 'waquar5555').trim().slice(0, 16)
const SERVERS = parseServers(process.env.MC_SERVERS || process.env.MC_HOST, 'world.arterex.me')
const AUTH = (process.env.MC_AUTH || 'offline').trim().toLowerCase()

const tokenFromEnv = (process.env.CHAT_TOKEN || '').trim()

const config = {
  // ── Minecraft ────────────────────────────────────────────────────────────
  bot: {
    username: USERNAME,
    servers: SERVERS,
    auth: AUTH === 'microsoft' ? 'microsoft' : 'offline',
    version: (process.env.MC_VERSION || '').trim() || false, // false = auto-detect
    joinMessage: (process.env.MC_JOIN_MESSAGE || '').trim(),
    viewDistance: int(process.env.MC_VIEW_DISTANCE, 6),
    hideErrors: bool(process.env.MC_HIDE_ERRORS, true),
    respawn: bool(process.env.MC_RESPAWN, true),
    checkTimeoutInterval: int(process.env.MC_CHECK_TIMEOUT, 30000),
    // Premium account joining an offline-mode server needs skipValidation=true.
    skipValidation: bool(process.env.MC_SKIP_VALIDATION, AUTH !== 'microsoft'),
    // Optional custom regex (group 1 = author, group 2 = message) for chat plugins.
    chatAuthorPattern: (process.env.CHAT_AUTHOR_PATTERN || '').trim() || null,
    profilesFolder: process.env.MC_PROFILES_FOLDER
      ? path.resolve(process.env.MC_PROFILES_FOLDER)
      : path.join(__dirname, '..', '.mc-profiles')
  },

  reconnect: {
    enabled: bool(process.env.RECONNECT, true),
    delayMs: int(process.env.RECONNECT_DELAY_MS, 5000),
    maxDelayMs: int(process.env.RECONNECT_MAX_DELAY_MS, 60000),
    maxAttempts: int(process.env.RECONNECT_MAX_ATTEMPTS, 0)
  },

  // ── Web ──────────────────────────────────────────────────────────────────
  web: {
    port: int(process.env.PORT, 8080),
    host: process.env.HOST || '0.0.0.0',
    chatToken: tokenFromEnv,
    anonymousChat: bool(process.env.ALLOW_ANONYMOUS_CHAT, false),
    allowServerSwitch: bool(process.env.ALLOW_SERVER_SWITCH, false),
    allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    historySize: int(process.env.CHAT_HISTORY, 400),
    logFile: (process.env.CHAT_LOG_FILE || 'data/chat.jsonl').trim(),
    showActionBar: bool(process.env.SHOW_ACTION_BAR, false),
    rateLimit: {
      messages: int(process.env.RATE_LIMIT_MESSAGES, 8),
      windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 10000)
    },
    sendCooldownMs: int(process.env.SEND_COOLDOWN_MS, 800),
    pingServer: bool(process.env.PING_SERVER, true),
    publicDir: path.join(__dirname, '..', 'public')
  },

  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  noBot: bool(process.env.NO_BOT, false) || process.argv.includes('--no-bot')
}

/** Warn about (and repair) the most common misconfigurations. */
function validate (log = console.warn) {
  const warnings = []

  if (!/^[A-Za-z0-9_]{3,16}$/.test(config.bot.username)) {
    warnings.push(
      `MC_USERNAME "${config.bot.username}" is not a valid Minecraft name (3-16 chars, A-Z 0-9 _). ` +
        'Offline-mode servers will still accept it, but some anti-cheat plugins will not.'
    )
  }

  if (!config.bot.servers.length) {
    warnings.push('MC_SERVERS is empty — the bot has nowhere to connect. Set MC_SERVERS=host:port')
  }

  if (!config.web.chatToken) {
    if (config.web.anonymousChat) {
      warnings.push(
        'No CHAT_TOKEN set and ALLOW_ANONYMOUS_CHAT=true: ANYONE who finds the site can chat on your server.'
      )
    } else {
      // Generate an ephemeral token so the dashboard still works, but make it obvious.
      config.web.chatToken = 'local-' + crypto.randomBytes(12).toString('hex')
      warnings.push(`No CHAT_TOKEN in .env — generated a temporary one for this run: ${config.web.chatToken}`)
    }
  } else if (config.web.chatToken.length < 12) {
    warnings.push('CHAT_TOKEN is very short. Use at least 24 random characters.')
  }

  if (config.bot.auth === 'microsoft' && !fs.existsSync(config.bot.profilesFolder)) {
    warnings.push(
      `MC_AUTH=microsoft but no cached login found in ${config.bot.profilesFolder}. ` +
        'Run `npm run login:microsoft` once to sign in.'
    )
  }

  if (config.web.logFile && config.web.logFile !== 'false') {
    const dir = path.dirname(path.resolve(config.web.logFile))
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      warnings.push(`Cannot create chat log directory ${dir}: ${err.message}`)
      config.web.logFile = 'false'
    }
  } else {
    config.web.logFile = null
  }

  warnings.forEach((w) => log(`[config] ${w}`))
  return warnings
}

module.exports = { config, validate, parseServers, bool, int }
