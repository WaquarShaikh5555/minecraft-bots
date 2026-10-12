# Troubleshooting

Start here: **`npm run diagnose`** (or `npm run diagnose:login`) checks DNS, TCP,
the server-list ping and — with `--login` — a real offline login, printing what
each failure means.

---

## The bot

### It says `Failed to verify username!` / `Invalid session`
Your server is **online-mode=true**. Either set `online-mode=false` in
`server.properties` (and restart), or use a premium account:
`npm run login:microsoft` then `MC_AUTH=microsoft`.
Details: [cracked-vs-premium.md](cracked-vs-premium.md).

### `Outdated client! Please use X` / `Unsupported version`
Set the version explicitly:
```ini
MC_VERSION=1.20.4
```
Mineflayer 4.39 covers 1.8.8 → 1.21.11 / 26.1. Bedrock servers are **not**
supported (that is a different protocol).

### `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`
- `ENOTFOUND` → DNS. Check the hostname (`dig +short world.arterex.me`), and
  whether the address actually lives in a `_minecraft._tcp` **SRV** record.
- `ECONNREFUSED` → nothing listening on that port. Wrong port? Server down?
- `ETIMEDOUT` → a firewall dropped it. Azure allows all *outbound* by default;
  check the Minecraft host's firewall and your NSG.

### `You are not whitelisted!`
```
whitelist add waquar5555
```

### `Timed out` right after joining
Raise the keep-alive tolerance:
```ini
MC_CHECK_TIMEOUT=60000
```

### The bot joins and immediately leaves, over and over
Look at `journalctl -u minecraft-bot -f`. Common causes: an anti-bot plugin
(e.g. a "join the game to verify" captcha), a login plugin demanding `/login`,
or two instances of the bot running with the same name (one kicks the other).
For an AuthMe-style plugin, put the password in the join message:
```ini
MC_JOIN_MESSAGE=/login mypassword|/register mypassword mypassword
```

### Kicked for spamming
Raise `SEND_COOLDOWN_MS` (default 800) and lower `RATE_LIMIT_MESSAGES`.

### Chat shows up but names are wrong / missing
Your server uses a custom chat format. Set `CHAT_AUTHOR_PATTERN`
(see [cracked-vs-premium.md](cracked-vs-premium.md#custom-chat-prefixes)), or
check that chat is not arriving on the action bar (`SHOW_ACTION_BAR=true` to see
it, but it is noisy).

### Behind Velocity / BungeeCord
Connect to the **proxy** address, and if the proxy uses `modern` forwarding with
`online-mode=false`, pin `MC_VERSION` to the backend version.

### High CPU
The bot only reads chat; it does not load chunk physics beyond what Mineflayer
needs. If CPU spikes, lower `MC_VIEW_DISTANCE=3`.

---

## The website

### The page loads but stays "socket offline"
1. Open the browser console. `Mixed Content: ws:// …` means the page is HTTPS
   and the bridge is HTTP → give the bridge HTTPS (Cloudflare tunnel or certbot).
2. `4003 bad origin` → add your site's origin to `ALLOWED_ORIGINS` in `.env` and
   restart the service.
3. Behind nginx, make sure the `Upgrade`/`Connection` headers are forwarded
   (see `deploy/nginx/bot.conf`) — without them the WebSocket handshake fails
   while the page itself loads fine.

### "token needed" and nothing I send works
Open ⚙ Settings → paste `CHAT_TOKEN` from `.env` → **Test token** → Save.
The token is stored only in that browser's localStorage.

### `401 unauthorized` from curl
Pass it as a header: `-H "X-Chat-Token: $TOKEN"`, or in the JSON body.

### `429 Too Many Requests`
`RATE_LIMIT_MESSAGES` per `RATE_LIMIT_WINDOW_MS` per client IP. Behind a proxy
make sure `trust proxy` sees the real IP (it is enabled by default).

### The feed shows old lines after a restart
The in-memory buffer starts empty on boot; only the `data/chat.jsonl` archive
survives. That is intentional — the dashboard is a live view, not a database.

### The site is public and I don't want strangers reading chat
Put it behind Cloudflare Access (free up to 50 users), an nginx
`auth_basic` location, or keep the port closed and reach it over an SSH tunnel:
```bash
ssh -L 8080:localhost:8080 azureuser@<vm-ip>     # then open http://localhost:8080
```

---

## Deployment

### `systemctl status minecraft-bot` → "activating (auto-restart)"
```bash
journalctl -u minecraft-bot -n 100 --no-pager
```
Almost always one of: missing `.env`, wrong `CHAT_TOKEN` characters (no spaces!),
`EADDRINUSE` (something else on the port), or Node < 22.

### `Error: listen EADDRINUSE: address already in use :::8080`
```bash
sudo ss -lptn 'sport = :8080'      # who owns it
sudo systemctl stop <that>         # or change PORT in .env
```

### The service runs but I can't reach it from my browser
1. On the VM: `curl -s localhost:8080/healthz` → must answer.
2. Azure: VM → Networking → inbound rule for TCP 8080 (or 80/443).
3. VM firewall: `sudo ufw status` → `sudo ufw allow 8080/tcp` if active.
4. `HOST=0.0.0.0` in `.env` (not `127.0.0.1`).

### GitHub Actions deploy does nothing
It skips until `VM_HOST`, `VM_USER` and `VM_SSH_KEY` exist as repository
secrets. The run log prints a notice saying exactly that.

### `npm ci` fails on the VM
Delete `node_modules` and the lockfile, then `npm install --omit=dev`.
Also make sure the service user owns the folder:
`sudo chown -R minecraft:minecraft /opt/minecraft-bots`.

### Microsoft login fails on a headless VM
That is expected to work — the device-code flow only needs a browser on your
phone. If `npm run login:microsoft` errors with a network message, the VM cannot
reach `login.microsoftonline.com` (check outbound rules / proxy).

---

## Still stuck?

```bash
journalctl -u minecraft-bot -n 200 --no-pager > /tmp/bot.log
npm run diagnose:login 2>&1 | tee -a /tmp/bot.log
cat /opt/minecraft-bots/.env | sed 's/^CHAT_TOKEN=.*/CHAT_TOKEN=<redacted>/' >> /tmp/bot.log
```
Open an issue with `/tmp/bot.log` attached (**redact the token first**).
