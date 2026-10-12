# Hosting the website for free

The dashboard is **pure static files** (`public/`) talking to the Node bridge
over HTTP + WebSocket. That means you can serve it from anywhere — including the
same VM that runs the bot, which is already free.

Four options, cheapest first:

| # | Where the site lives | Where the WebSocket goes | Cost | Best when |
|---|---|---|---|---|
| A | The VM itself (default) | Same origin | free (inside your Azure credit) | You just want it to work |
| B | Cloudflare quick tunnel | Same origin, free HTTPS | free, no domain | You want `https://` today |
| C | GitHub Pages | Your VM behind a tunnel/nginx | free | You want a pretty, always-on URL for the site |
| D | Cloudflare Pages / Netlify | Your VM behind a tunnel/nginx | free | Same as C, faster deploys |

> **The one rule that trips everyone up:** a page loaded over `https://` may
> only open a **secure** WebSocket (`wss://`). So if you host the site on GitHub
> Pages (HTTPS), the VM must also be reachable over HTTPS — that is what the
> Cloudflare tunnel or certbot is for. If the site is served by the VM itself
> over plain `http://`, everything stays same-origin and it just works.

---

## Option A — serve it from the VM (zero extra work)

This is what `npm start` already does. Visit:

```
http://<vm-public-ip>:8080
```

Nothing else to configure: the page and the WebSocket share an origin, so
`ALLOWED_ORIGINS` can stay empty (that is also the most secure default — only
your own site can talk to the API).

## Option B — free HTTPS with a Cloudflare quick tunnel

No domain, no DNS, no open ports. On the VM:

```bash
sudo bash deploy/setup-azure-vm.sh --tunnel      # installs + starts it
# or by hand:
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
sudo chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://localhost:8080
```

It prints `https://random-words.trycloudflare.com` — that URL serves the
dashboard **with** working WebSockets. Downside: a new random URL every restart.

### Make it permanent (you already own `arterex.me`)

```bash
cloudflared tunnel login                          # authorise your domain once
cloudflared tunnel create minecraft-bot           # prints a TUNNEL UUID
cloudflared tunnel route dns minecraft-bot bot.arterex.me
sudo mkdir -p /etc/cloudflared
sudo cp deploy/cloudflared/config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml             # fill in UUID + credentials path
sudo cloudflared service install
systemctl status cloudflared
```

Now `https://bot.arterex.me` is your dashboard, forever, with free TLS, and the
VM has **no inbound ports at all** (you can delete the 8080 NSG rule).

## Option C — GitHub Pages (free with your Student Pack)

The site becomes `https://<your-user>.github.io/minecraft-bots/` and talks to the
VM. One-time setup:

1. Give the VM a public HTTPS address first (Option B).
2. Repo → **Settings → Pages → Source: GitHub Actions**.
3. Repo → **Settings → Secrets and variables → Actions → Variables** → add
   `BOT_GATEWAY` = `https://bot.arterex.me`.
4. On the VM, allow that Pages origin in `/opt/minecraft-bots/.env`:
   ```ini
   ALLOWED_ORIGINS=https://waquar5555.github.io
   ```
   then `sudo systemctl restart minecraft-bot`.
5. Push to `main`. `.github/workflows/pages.yml` copies `public/` into `site/`,
   rewrites `gateway:` in `config.js`, and publishes it.

The workflow refuses to publish if `BOT_GATEWAY` is missing, so you never end up
with a page that silently cannot connect.

## Option D — Cloudflare Pages or Netlify

Both are free, both do instant HTTPS, both accept a plain folder:

1. Cloudflare Pages → **Create → Upload assets** → drag in the `public/` folder
   (or connect the repo with build command `exit 0` and output dir `public`).
2. Edit `public/config.js` first:
   ```js
   window.BOT_BRIDGE_CONFIG = { gateway: 'https://bot.arterex.me', /* … */ }
   ```
3. Add the resulting Pages origin to `ALLOWED_ORIGINS` on the VM and restart.

Netlify: same idea, drag-and-drop `public/` at <https://app.netlify.com/drop>.

---

## What `config.js` does

```js
window.BOT_BRIDGE_CONFIG = {
  gateway: '',            // '' = "same origin as this page" (Option A/B)
  wsPath: '/ws',          // WebSocket path on the bridge
  apiBase: '/api',        // REST endpoints
  title: 'waquar5555 · live Minecraft chat',
  fallbackBotName: 'waquar5555',
  autoToken: ''           // see the warning below
}
```

Everything else in the dashboard adapts automatically: the WS URL is derived from
`gateway` (`https:` → `wss:`), and if the socket cannot be used the client falls
back to plain `fetch()` calls for sending.

## Security checklist before you share the link

- [ ] `CHAT_TOKEN` is a long random string (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).
- [ ] `ALLOW_ANONYMOUS_CHAT=false` — otherwise **anyone** who finds the URL can
      chat on your server as `waquar5555`.
- [ ] `autoToken` in `config.js` is **empty** if the repo/site is public. Anyone
      reading it could chat. Type the token once in ⚙ Settings instead — it is
      kept in your browser's localStorage.
- [ ] `ALLOWED_ORIGINS` lists only the origins you actually use.
- [ ] `ALLOW_SERVER_SWITCH=false` unless you want visitors moving the bot around.
- [ ] Reading the chat is public by design. If your server chat is private, put
      the dashboard behind Cloudflare Access (free for 50 users) or a Basic-auth
      nginx location.

## Reverse-proxy note

`app.set('trust proxy', 1)` is already on, so behind nginx/Cloudflare the
rate limiter sees real client IPs (`CF-Connecting-IP` / `X-Forwarded-For`)
instead of `127.0.0.1` for everyone.
