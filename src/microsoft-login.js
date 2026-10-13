#!/usr/bin/env node
'use strict'

/**
 * One-off Microsoft login for PREMIUM accounts.
 *
 *   npm run login:microsoft
 *
 * Opens the Xbox device-code flow, prints a URL + code, and caches the tokens
 * in .mc-profiles/ so the bot can later start with MC_AUTH=microsoft without
 * any browser on the server.
 *
 * You only need this if your Minecraft server runs online-mode=true. For a
 * cracked / offline server, MC_AUTH=offline needs no login at all.
 */

const path = require('path')
const fs = require('fs')
const { Authflow, Titles } = require('prismarine-auth')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const username = (process.env.MC_USERNAME || 'waquar5555').trim()
const profilesFolder = process.env.MC_PROFILES_FOLDER
  ? path.resolve(process.env.MC_PROFILES_FOLDER)
  : path.join(__dirname, '..', '.mc-profiles')

const LINE = '─'.repeat(62)

function onMsaCode (code) {
  console.log(`\n${LINE}`)
  console.log('  SIGN IN WITH THE MINECRAFT ACCOUNT')
  console.log('')
  console.log(`  1. Open    : ${code.verification_uri}`)
  console.log(`  2. Enter   : ${code.user_code}`)
  console.log(`  3. Expires : ${code.expires_in}s — waiting for you to finish…`)
  console.log(`${LINE}\n`)
}

async function main () {
  console.log(`Microsoft login for "${username}"`)
  console.log(`Token cache: ${profilesFolder}\n`)

  fs.mkdirSync(profilesFolder, { recursive: true })

  // Must match what minecraft-protocol uses internally, or the cache will not
  // be reused when the bot starts.
  const options = {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  }

  const flow = new Authflow(username, profilesFolder, options, onMsaCode)

  let token
  try {
    token = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: true })
  } catch (err) {
    console.warn(`\nChat-signing certificates failed (${err?.message || err}) — retrying without them.\n`)
    token = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: false })
  }

  const profile = token?.profile || {}
  console.log('\n' + LINE)
  console.log('  LOGIN OK')
  console.log(`  name : ${profile.name || username}`)
  console.log(`  uuid : ${profile.id || '(not returned)'}`)
  console.log(LINE)
  console.log('\nNext steps:')
  console.log('  1. In .env set:  MC_AUTH=microsoft')
  console.log('  2. If your server is cracked (online-mode=false) also set:  MC_SKIP_VALIDATION=true')
  console.log('  3. Restart the bot:  npm start')
  console.log(`\nKeep ${profilesFolder} private — it contains your account tokens.\n`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\nLogin failed:', err?.message || err)
  if (/Not Found|does the account own minecraft|profile/i.test(String(err?.message || err))) {
    console.error('Hint: that Microsoft account does not own Minecraft Java Edition.')
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(String(err?.message || err))) {
    console.error('Hint: this machine cannot reach login.microsoftonline.com / api.minecraftservices.com.')
  }
  process.exit(1)
})
