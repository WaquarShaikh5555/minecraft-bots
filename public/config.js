/**
 * Dashboard configuration.
 *
 * Leave `gateway` empty when the site is served by the same Node process as the
 * bot (the default: `npm start`, or the VM's http://IP:8080).
 *
 * If you host this folder on GitHub Pages / Cloudflare Pages / Netlify instead,
 * point `gateway` at the public HTTPS address of the VM, e.g.
 *
 *   gateway: "https://bot.arterex.me"
 *
 * and add that Pages origin to ALLOWED_ORIGINS in the VM's .env.
 * The gateway MUST be https:// (browsers block ws:// from an https:// page).
 */
window.BOT_BRIDGE_CONFIG = {
  gateway: '',
  wsPath: '/ws',
  apiBase: '/api',
  title: 'waquar5555 · live Minecraft chat',
  fallbackBotName: 'waquar5555',

  // Convenience only — a token committed to a public repo lets anyone chat.
  // Prefer typing it once in Settings (it is stored in your browser).
  autoToken: ''
}
