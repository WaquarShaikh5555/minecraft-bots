# API reference

Everything the dashboard uses is a plain HTTP/JSON or WebSocket API, so you can
drive the bot from a phone shortcut, a Discord webhook, Python, whatever.

Base URL: `http://<vm>:8080` (or your tunnel domain).

Authentication for **writing**: send the token in any of these forms

```
X-Chat-Token: <token>
Authorization: Bearer <token>
POST body { "token": "..." }
WS query   ?token=...
```

Reading (`GET /api/state`, `/api/messages`, `/api/config`, `/healthz`) is open.

---

## REST

### `GET /healthz`

```json
{ "ok": true, "phase": "online", "online": true, "version": "1.0.0" }
```

### `GET /api/config`

Non-secret settings the UI needs: bot name, auth mode, server list, whether the
token is required, rate limits.

### `GET /api/state`

```json
{
  "ok": true,
  "state": {
    "phase": "online",
    "online": true,
    "username": "waquar5555",
    "auth": "offline",
    "version": "1.20.4",
    "server": { "host": "world.arterex.me", "port": 25565, "label": "world.arterex.me:25565" },
    "servers": [ ... ],
    "connectedAt": 1791827500000,
    "uptimeMs": 2520000,
    "attempts": 0,
    "lastError": null,
    "lastErrorHint": null,
    "health": 20,
    "food": 18,
    "position": { "x": 128, "y": 64, "z": -256 },
    "dimension": "minecraft:overworld",
    "time": { "day": 7, "age": 174000, "clock": "12:00" },
    "players": [{ "username": "Alex", "display": "Alex", "ping": 42, "gamemode": "survival", "isSelf": false }],
    "playerCount": 5,
    "maxPlayers": 40,
    "serverInfo": { "motd": "…", "online": 5, "max": 40, "version": "1.20.4", "protocol": 765 },
    "counters": { "received": 132, "sent": 4, "web": 4, "dropped": 0 }
  }
}
```

`phase` is one of `idle | connecting | online | reconnecting | stopped | error`.

### `GET /api/messages?since=<id>&limit=<n>`

Incremental history. `since` is exclusive; pass the `lastId` you already have.

### `POST /api/chat` 🔒

```json
{ "text": "hello from curl", "token": "…" }
```

→ `{"ok":true}` or `409 {"ok":false,"code":"send_failed","error":"Bot is not connected (phase: reconnecting)."}`

Text starting with `/` is sent as a **command** (`/list`, `/spawn`, `/msg Alex hi`).
Messages longer than the vanilla chat limit are split automatically by Mineflayer.

```bash
curl -sX POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -H "X-Chat-Token: $CHAT_TOKEN" \
  -d '{"text":"hello world"}'
```

### `POST /api/action` 🔒

```json
{ "action": "reconnect" }
```

Actions: `reconnect`, `respawn`, `refresh-players`, `refresh-server-info`.

### `POST /api/server` 🔒 (needs `ALLOW_SERVER_SWITCH=true`)

```json
{ "label": "beta.test:25565" }
```

Moves the bot to another entry of `MC_SERVERS`.

### `POST /api/clear` 🔒

Empties the in-memory feed and tells every connected browser to clear too. The
JSONL archive on disk is untouched.

### `GET|POST /api/verify`

```json
{ "ok": true, "authorized": true, "anonymous": false }
```

Token check for the "Test token" button. Never echoes the token back.

### Errors

| Status | Meaning |
|---|---|
| 400 | empty message |
| 401 | missing/wrong token |
| 403 | wrong `Origin`, or feature disabled |
| 409 | bot offline / unknown action / send failed |
| 429 | rate limited (`Retry-After` header included) |

---

## WebSocket — `GET /ws`

One JSON object per frame, both directions.

### Server → client

| `type` | When | Payload |
|---|---|---|
| `hello` | on connect | `state`, `messages` (full replay), `lastId`, `you:{authenticated, anonymousChat}` |
| `message` | every chat line | `message`, `counters` |
| `state` | any state change | `state` |
| `sync` | reply to your `sync` | `messages`, `lastId` |
| `ack` | reply to your `chat`/`action`/`switch` | `id`, `ok`, `error` |
| `auth` | reply to your `auth` | `ok`, `message` |
| `cleared` | someone cleared the feed | — |
| `pong` | reply to your `ping` | `t` |
| `error` | protocol problem | `code`, `message` |

### Client → server

| `type` | Payload | Needs token |
|---|---|---|
| `auth` | `token` | — |
| `chat` | `text`, `id?` | ✅ |
| `action` | `action`, `id?` | ✅ |
| `switch` | `label`, `id?` | ✅ |
| `sync` | `since` | — |
| `ping` | — | — |

A `ping`/`pong` frame every 30 s reaps dead sockets.

### Message record

```json
{
  "id": 128,
  "ts": 1791827539011,
  "kind": "chat",
  "author": "Alex",
  "text": "gg that was close",
  "motd": "§agg that was close",
  "server": "world.arterex.me:25565",
  "meta": { "position": "chat", "verified": true, "sender": null, "full": "<Alex> gg that was close", "self": false }
}
```

`kind`: `chat` (player chat) · `bot` (the bot itself, incl. lines you sent from
the site) · `system` (server messages) · `player` (joins/leaves/deaths) ·
`whisper` (`/msg`) · `actionbar` (hidden unless `SHOW_ACTION_BAR=true`) ·
`status` (bridge/bot lifecycle events).

`motd` keeps Minecraft `§` colour codes; the dashboard renders them with its own
parser and always writes text via `textContent`, so hostile chat can never inject
HTML into your page.

### Minimal client (Node 22+, no dependencies)

```js
const ws = new WebSocket('ws://localhost:8080/ws?token=YOUR_TOKEN')
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'message') console.log(`${msg.message.author ?? '*'}: ${msg.message.text}`)
  if (msg.type === 'hello') {
    ws.send(JSON.stringify({ type: 'chat', text: 'hello from node', id: '1' }))
  }
  if (msg.type === 'ack') console.log('ack:', msg.ok, msg.error ?? '')
}
```

---

## Chat archive

`data/chat.jsonl` gets one JSON record per line (same shape as above), appended
forever until you rotate it:

```bash
tail -f data/chat.jsonl
jq -r 'select(.kind=="chat") | "\(.author): \(.text)"' data/chat.jsonl | tail -20
```

Disable with `CHAT_LOG_FILE=false`.
