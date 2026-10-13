#!/usr/bin/env node
'use strict'

/**
 * Entry point: starts the web dashboard and (unless disabled) the Mineflayer bot.
 *
 *   npm start                 -> bot + website
 *   npm start -- --demo       -> website with simulated chat (no server needed)
 *   npm run web               -> website only, no Minecraft connection
 */

const http = require('http')
const os = require('os')

const { config, validate } = require('./config')
const { createLogger } = require('./logger')
const { Store } = require('./store')
const { BotManager } = require('./bot')
const { DemoBot } = require('./demo')
const { createServer } = require('./server')

const log = createLogger(config.logLevel)
const demo = process.argv.includes('--demo') || ['1', 'true'].includes(String(process.env.DEMO || '').toLowerCase())

function banner (url, extra) {
  const line = '─'.repeat(64)
  log.info(`\n${line}`)
  log.info('  Minecraft bot + live chat bridge')
  log.info(`  bot name    : ${config.bot.username}  (${config.bot.auth} mode)`)
  log.info(`  servers     : ${config.bot.servers.map((s) => s.label).join(', ') || '(none)'}`)
  log.info(`  dashboard   : ${url}`)
  if (extra) extra.forEach((l) => log.info(`  ${l}`))
  log.info(`${line}\n`)
}

/** Placeholder used when the bot is disabled — keeps the API contract intact. */
function createDisabledBot (store) {
  store.setState({ phase: 'stopped', lastError: 'Started in web-only mode (NO_BOT=true).' })
  store.push({ kind: 'status', text: 'Web-only mode: the Minecraft bot is disabled.', meta: { source: 'app' } })
  const off = { ok: false, error: 'The bot is disabled in this process (NO_BOT=true).' }
  return {
    start: async () => false,
    stop: async () => {},
    sendChat: async () => off,
    action: async () => off,
    switchServer: async () => off,
    target: null
  }
}

async function main () {
  validate((msg) => log.warn(msg))

  const store = new Store({
    historySize: config.web.historySize,
    logFile: config.web.logFile
  })

  const bot = demo
    ? new DemoBot(store, config)
    : config.noBot
      ? createDisabledBot(store)
      : new BotManager(store, config, (...a) => log.info(...a))

  const web = createServer({ store, bot, config, log: (...a) => log.info(...a) })
  const server = http.createServer(web.app)
  web.attachWebSocket(server)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.web.port, config.web.host, resolve)
  })

  const address = server.address()
  const shownPort = typeof address === 'object' ? address.port : config.web.port
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)
  const urls = [`http://${config.web.host === '0.0.0.0' ? 'localhost' : config.web.host}:${shownPort}`]
  if (lan) urls.push(`http://${lan.address}:${shownPort} (LAN)`)

  banner(urls[0], [
    ...urls.slice(1),
    `mode        : ${demo ? 'DEMO (simulated chat)' : config.noBot ? 'web only' : 'live bot'}`,
    `chat token  : ${config.web.anonymousChat ? '(anonymous chat ENABLED)' : 'required for sending — set CHAT_TOKEN in .env'}`
  ])

  if (!config.noBot) {
    bot.start().catch((err) => log.error('[app] bot start failed:', err?.message || err))
  }

  /* ────────────────────────── graceful shutdown ───────────────────────── */

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`[app] ${signal} received — shutting down`)
    const killer = setTimeout(() => process.exit(1), 8000)
    killer.unref?.()
    try {
      web.close()
      await bot.stop(signal)
      store.close()
      server.close(() => process.exit(0))
    } catch (err) {
      log.error('[app] shutdown error:', err?.message || err)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    log.error('[app] uncaught exception:', err?.stack || err?.message || err)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('[app] unhandled rejection:', reason?.stack || reason?.message || reason)
  })
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[app] failed to start:', err)
  process.exit(1)
})
