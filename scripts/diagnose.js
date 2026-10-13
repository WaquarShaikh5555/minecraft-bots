#!/usr/bin/env node
'use strict'

/**
 * Diagnose why the bot cannot reach a server — without starting the bot.
 *
 *   node scripts/diagnose.js                       # every server in .env
 *   node scripts/diagnose.js world.arterex.me      # just one host
 *   node scripts/diagnose.js --login               # also try a real offline login
 *
 * Checks: DNS → TCP → server-list ping (MOTD/version/players) → [optional login]
 */

const dns = require('node:dns').promises
const net = require('node:net')
const mc = require('minecraft-protocol')
const { config } = require('../src/config')
const { parseServers } = require('../src/config')
const { componentText, stripColors } = require('../src/text')

const argv = process.argv.slice(2)
const tryLogin = argv.includes('--login')
const explicit = argv.filter((a) => !a.startsWith('--'))
const targets = explicit.length ? parseServers(explicit.join(',')) : config.bot.servers

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const OFF = '\x1b[0m'

const ok = (m) => console.log(`  ${GREEN}✓${OFF} ${m}`)
const bad = (m) => console.log(`  ${RED}✗${OFF} ${m}`)
const warn = (m) => console.log(`  ${YELLOW}!${OFF} ${m}`)
const dim = (m) => console.log(`    ${DIM}${m}${OFF}`)
const head = (m) => console.log(`\n${BOLD}${m}${OFF}`)

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))

async function checkDns (host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    ok(`${host} is already an IP`)
    return host
  }
  try {
    const res = await Promise.race([dns.lookup(host, { all: true }), timeout(5000)])
    ok(`DNS ${host} → ${res.map((r) => r.address).join(', ')}`)
    return res[0].address
  } catch (err) {
    bad(`DNS lookup failed for ${host}: ${err.code || err.message}`)
    if (err.code === 'ENOTFOUND') {
      dim('The hostname does not exist. Typo? Or the A record is missing/wrong.')
      dim(`Try: dig +short ${host}   or   nslookup ${host}`)
      dim('If the server is only reachable via SRV (_minecraft._tcp), use the real host from the SRV record.')
    }
    if (err.code === 'EAI_AGAIN') dim('Temporary DNS failure — usually the resolver or network is down.')
    return null
  }
}

async function checkTcp (host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 7000 })
    const finish = (good, msg) => {
      socket.destroy()
      if (good) ok(msg)
      else bad(msg)
      resolve(good)
    }
    socket.once('connect', () => finish(true, `TCP ${host}:${port} accepted the connection`))
    socket.once('timeout', () => finish(false, `TCP ${host}:${port} timed out (7s) — port closed or firewalled`))
    socket.once('error', (err) =>
      finish(false, `TCP ${host}:${port} failed: ${err.code || err.message}${err.code === 'ECONNREFUSED' ? ' — nothing is listening (wrong port? server down?)' : ''}`)
    )
  })
}

async function checkPing (host, port) {
  try {
    const info = await Promise.race([mc.ping({ host, port }), timeout(8000)])
    const version = info.version?.name || 'unknown'
    const protocol = info.version?.protocol
    ok(`Server-list ping answered: version ${version} (protocol ${protocol})`)
    ok(`Players ${info.players?.online ?? '?'}/${info.players?.max ?? '?'}`)

    const motd = componentText(info.description)
    if (motd.trim()) {
      dim(`MOTD: ${stripColors(motd).split('\n').join(' | ')}`)
    }

    if (info.enforcesSecureChat === false) dim('Chat signing is not enforced (good for bots).')
    if (protocol && (protocol < 47 || protocol > 800)) {
      warn(`Protocol ${protocol} is outside Mineflayer's usual range — set MC_VERSION explicitly if the login fails.`)
    }
    return info
  } catch (err) {
    warn(`Server-list ping failed: ${err?.message || err}`)
    dim('Some servers/proxies block pings but still accept players — try --login to be sure.')
    return null
  }
}

async function checkLogin (host, port, username) {
  console.log('')
  warn(`Attempting a real offline login as "${username}" — the server will see the bot join.`)
  return new Promise((resolve) => {
    let settled = false
    let client
    try {
      client = mc.createClient({ host, port, username, auth: 'offline', version: config.bot.version || false, hideErrors: true })
    } catch (err) {
      bad(`Could not create the client: ${err.message}`)
      return resolve(false)
    }
    const done = (good, msg) => {
      if (settled) return
      settled = true
      if (good) ok(msg)
      else bad(msg)
      try {
        client.end('diagnose done')
      } catch { /* noop */ }
      resolve(good)
    }

    const timer = setTimeout(() => done(false, 'Login attempt timed out after 25s'), 25000)
    client.on('login', () => {
      clearTimeout(timer)
      done(true, 'LOGIN SUCCEEDED — the server accepted an offline/cracked connection')
      dim(`Server version reported: ${client.version}`)
      dim('If the dashboard still shows nothing, the problem is on the web side, not the bot side.')
    })
    client.on('kick', (reason) => {
      clearTimeout(timer)
      const text = stripColors(typeof reason === 'string' ? reason : JSON.stringify(reason))
      done(false, `Kicked: ${text}`)
      if (/verify username|invalid session|premium|not logged in|authentication/i.test(text)) {
        dim('→ This server is online-mode=true. Either set online-mode=false in server.properties,')
        dim('  or use MC_AUTH=microsoft after `npm run login:microsoft`.')
      }
      if (/whitelist/i.test(text)) dim(`→ whitelist add ${username}`)
      if (/outdated|version/i.test(text)) dim('→ set MC_VERSION=<the version the server reports> in .env')
      if (/already logged in|connected from another location/i.test(text)) {
        dim('→ the name is already in use. Rename the bot, or make sure only one instance is running.')
      }
    })
    client.on('error', (err) => {
      clearTimeout(timer)
      done(false, `Error: ${err?.message || err}`)
    })
    client.on('end', (reason) => {
      clearTimeout(timer)
      if (!settled) done(false, `Connection ended: ${reason || 'unknown'}`)
    })
  })
}

async function main () {
  console.log(`${BOLD}Minecraft bot diagnostics${OFF}`)
  console.log(`  node     : ${process.version}`)
  console.log(`  mineflayer: ${require('mineflayer/package.json').version}`)
  console.log(`  bot name : ${config.bot.username}  (auth: ${config.bot.auth})`)
  console.log(`  targets  : ${targets.map((t) => t.label).join(', ') || '(none — MC_SERVERS is empty!)'}`)

  if (!targets.length) {
    bad('No servers configured. Set MC_SERVERS=host:port in .env')
    process.exit(1)
  }

  let allGood = true
  for (const target of targets) {
    head(`── ${target.label}`)
    const ip = await checkDns(target.host)
    if (!ip) {
      allGood = false
      continue
    }
    const tcp = await checkTcp(ip, target.port)
    if (!tcp) {
      allGood = false
      dim('Outbound blocked? Azure VMs allow all outbound by default, but check nsg/ufw on your side.')
      continue
    }
    await checkPing(target.host, target.port)
    if (tryLogin) {
      const loggedIn = await checkLogin(target.host, target.port, config.bot.username)
      if (!loggedIn) allGood = false
    }
  }

  head('── dashboard')
  const port = config.web.port
  try {
    const res = await Promise.race([fetch(`http://127.0.0.1:${port}/healthz`), timeout(2000)])
    const data = await res.json()
    ok(`http://127.0.0.1:${port}/healthz → ${JSON.stringify(data)}`)
  } catch {
    warn(`Nothing answering on port ${port} — is the app running? (systemctl status minecraft-bot)`)
  }

  head(allGood ? 'Result: reachable ✓' : 'Result: problems found ✗')
  if (!tryLogin) dim('Run again with --login to test an actual offline login.')
  console.log('')
  process.exit(allGood ? 0 : 1)
}

main().catch((err) => {
  console.error('diagnose crashed:', err)
  process.exit(1)
})
