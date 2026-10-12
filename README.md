# minecraft-bots — `waquar5555`

A headless **Minecraft Java bot** ([Mineflayer](https://github.com/PrismarineJS/mineflayer))
plus a **live web dashboard**: see the chat of whatever server the bot is on, in
real time, and talk back through it from any browser.

Built for `world.arterex.me`, works with any Java server (1.8.8 → 1.21.11 / 26.1),
offline/cracked **or** premium, and deploys to a free Azure student VM.

```
┌─────────────┐   Minecraft protocol    ┌──────────────────┐   WebSocket    ┌──────────┐
│ MC server   │◄───────────────────────►│  this app (VM)   │◄──────────────►│ browser  │
│ world.      │   bot = waquar5555      │  bot + bridge +  │   REST/WS      │ dashboard│
│ arterex.me  │   offline mode login    │  static site     │                │          │
└─────────────┘                         └──────────────────┘                └──────────┘
```

---

## Try it in 30 seconds (no Minecraft server needed)

```bash
npm install
npm start -- --demo      # simulated chat: the whole UI is live and interactive
```

Open <http://localhost:8080>, send a message, watch it appear.

Then for real:

```bash
cp .env.example .env     # edit CHAT_TOKEN — everything else already points at world.arterex.me
npm start
```

## What you get

**The bot**
- Offline/cracked login by default (`MC_AUTH=offline`) — no Microsoft account needed.
  Premium login supported too (`npm run login:microsoft`).
- Auto-reconnect with exponential backoff + jitter, survives kicks and restarts.
- Explains its own failures: an online-mode server, a version mismatch, DNS and
  rate limits all produce a human-readable hint in the UI instead of a stack trace.
- Captures player chat, whispers, system lines, joins/leaves — **with Minecraft
  `§` colours preserved** — plus health, food, position, dimension, world time and
  the tab-list (players + ping).
- Outgoing chat is queued and throttled so the bot never gets kicked for spam.
- Optional JSONL archive of every line (`data/chat.jsonl`).

**The dashboard**
- Live feed with coloured text, per-player name colours, timestamps, filters
  (All / Chat / Mine / System / Joins / Whispers) and search.
- Chat composer: type as the bot, `/commands` included, with quick-command chips.
  Click any player name → pre-fills `/msg <name> `.
- Server card: MOTD, version, player counts, address, uptime — whatever server the
  bot is currently on, updated live.
- Bot vitals: health/food bars, coordinates, dimension, in-game clock.
- Status pills for both the bot connection and your browser's socket, unread-count
  jump button, auto-scroll pause, sound toggle, light/dark theme, compact mode.
- Export the visible feed as `.txt`; works on mobile; no CDN, no external fonts —
  it runs fully offline.
- Multi-server: put several addresses in `MC_SERVERS` and switch from the UI.

**Security**
- Reading is public (that is the point). **Writing needs `CHAT_TOKEN`**, compared
  in constant time, with per-IP rate limiting and an origin allowlist.
- Chat is rendered with `textContent` + a custom `§`-code parser — server chat can
  never inject HTML into your page.
- Runs as a non-root systemd user with `NoNewPrivileges`, `ProtectSystem`,
  `PrivateTmp` and a memory cap.

---

## Deploy it (Azure student VM, free)

One command on a fresh Ubuntu VM:

```bash
curl -fsSL https://raw.githubusercontent.com/WaquarShaikh5555/minecraft-bots/main/deploy/setup-azure-vm.sh \
  | sudo bash -s -- --bot-name waquar5555 --server world.arterex.me:25565 --tunnel
```

That installs Node 22, creates the service user, writes `.env` with a generated
token, installs the systemd unit, and (with `--tunnel`) gives you a free HTTPS
URL. Full walkthrough, including NSG rules and the free-tier maths:
**[docs/azure-vm.md](docs/azure-vm.md)**.

Then push to `main` and GitHub Actions redeploys over SSH — see
`.github/workflows/deploy.yml` (it skips until you add the `VM_*` secrets).

### Hosting the website for free

| Option | URL | Notes |
|---|---|---|
| The VM itself | `http://<vm-ip>:8080` | Already works, zero config |
| Cloudflare quick tunnel | `https://…trycloudflare.com` | Free HTTPS + WSS, no open ports |
| Cloudflare named tunnel | `https://bot.arterex.me` | Permanent, free, uses your own domain |
| nginx + certbot | `https://bot.arterex.me` | Free TLS on the VM, needs ports 80/443 |
| **GitHub Pages** | `https://<user>.github.io/minecraft-bots` | Free with your Student Pack; point `BOT_GATEWAY` at the VM |
| Cloudflare Pages / Netlify | your choice | Drag-and-drop the `public/` folder |

Everything, including the HTTPS/mixed-content gotcha:
**[docs/free-hosting.md](docs/free-hosting.md)**.

Docker also works: `docker compose up -d`.

---

## Configuration

Copy `.env.example` → `.env`. The important ones:

| Variable | Default | What it does |
|---|---|---|
| `MC_USERNAME` | `waquar5555` | Bot's in-game name |
| `MC_SERVERS` | `world.arterex.me:25565` | Comma-separated; first one is used on boot |
| `MC_AUTH` | `offline` | `offline` (cracked) or `microsoft` (premium) |
| `MC_VERSION` | *(auto)* | Pin only if auto-detect fails |
| `MC_SKIP_VALIDATION` | `true` | Premium account on a cracked server |
| `MC_JOIN_MESSAGE` | *(empty)* | Send something on join; separate lines with `\|` |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Dashboard bind |
| `CHAT_TOKEN` | *(generated)* | **Required to send chat from the site** |
| `ALLOW_ANONYMOUS_CHAT` | `false` | Let anyone chat without the token |
| `ALLOW_SERVER_SWITCH` | `false` | Let the site move the bot between servers |
| `ALLOWED_ORIGINS` | *(same-origin only)* | Needed when the site is hosted elsewhere |
| `CHAT_HISTORY` | `400` | Lines kept in memory and replayed to new visitors |
| `CHAT_LOG_FILE` | `data/chat.jsonl` | Persistent archive; `false` to disable |
| `RECONNECT*` | sane | Backoff, max delay, max attempts (`0` = forever) |
| `SEND_COOLDOWN_MS` | `800` | Minimum gap between two outgoing messages |
| `RATE_LIMIT_MESSAGES` | `8` / 10 s | Per-visitor burst limit |
| `CHAT_AUTHOR_PATTERN` | *(empty)* | Regex for servers with custom chat prefixes |

Full list with comments in [`.env.example`](.env.example).

## Commands

```bash
npm start                   # bot + dashboard
npm start -- --demo         # dashboard with simulated chat (no server needed)
npm start -- --no-bot       # dashboard only
npm run dev                 # auto-restart on file changes
npm test                    # 47 tests: unit, REST/WebSocket, reconnect paths, jsdom UI
npm run diagnose            # DNS / TCP / ping check for your server
npm run diagnose:login      # …plus a real offline login attempt
npm run login:microsoft     # one-off premium login (device code flow)
```

## Project layout

```
src/
  index.js             entry point, graceful shutdown
  config.js            env parsing + validation warnings
  bot.js               BotManager: connect, reconnect, capture, queued send
  server.js            Express REST + WebSocket bridge, auth, rate limits
  store.js             ring buffer + live state + JSONL archive
  text.js              chat parsing, § colours, failure explanations
  demo.js              simulated bot so you can build the UI offline
  microsoft-login.js   device-code login for premium accounts
  logger.js            tiny levelled logger
public/                the dashboard (static; hostable anywhere)
scripts/diagnose.js    connectivity doctor
deploy/                systemd unit, VM setup script, cloudflared, nginx
.github/workflows/     CI, SSH deploy, GitHub Pages publish
test/                  node:test suite — no mocks for the web layer, it is real HTTP+WS
docs/                  azure-vm · free-hosting · cracked-vs-premium · api · troubleshooting
```

## API

`GET /api/state`, `GET /api/messages?since=`, `POST /api/chat`, `POST /api/action`,
`POST /api/server`, `POST /api/verify`, `WS /ws` — full reference with payloads and
a 10-line Node client: **[docs/api.md](docs/api.md)**.

## Important notes

- **Cracked mode requires `online-mode=false` on your server.** Since it is your
  own server that is fine, but it also means anyone could join with your name —
  run an auth plugin and/or the whitelist. Read
  [docs/cracked-vs-premium.md](docs/cracked-vs-premium.md) before exposing it.
- Never commit `.env` or `.mc-profiles/` (both are gitignored). The token is the
  only thing standing between the internet and your server's chat.
- The bot holds no state on the server: it is a normal player that never moves.
  Some anti-cheat plugins may flag an idle player — whitelist it if needed.
- Mineflayer does not support Bedrock.

## License

MIT — do whatever you like. Credit to the
[PrismarineJS](https://github.com/PrismarineJS) people, whose protocol work makes
this trivial.
