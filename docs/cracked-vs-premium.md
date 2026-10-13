# Cracked (offline) vs premium — which login does your bot need?

Mineflayer speaks the real Minecraft Java protocol, so the only thing that
decides this is **your server's `online-mode` setting**.

| Your `server.properties` | Bot setting | Do you need a Microsoft account? |
|---|---|---|
| `online-mode=false` (cracked) | `MC_AUTH=offline` | **No** — this is the default here |
| `online-mode=true` (premium) | `MC_AUTH=microsoft` | **Yes** — the account must own Minecraft Java |
| `online-mode=false` + you still want your premium skin | `MC_AUTH=microsoft`, `MC_SKIP_VALIDATION=true` | Yes |

Version support in the bundled Mineflayer 4.39: **1.8.8 → 1.21.11** (and the new
`26.1` numbering). Leave `MC_VERSION=` empty and it is auto-detected from the
server; only pin it if auto-detect fails (common on Velocity/BungeeCord proxies).

---

## Offline mode (what `waquar5555` uses by default)

With `MC_AUTH=offline` the client generates a deterministic UUID from the
username (`uuid.nameToMcOfflineUUID`) and skips Mojang's session servers
entirely. No account, no email, no cost.

**Check your server** (`server.properties` on the machine running
`world.arterex.me`):

```properties
online-mode=false
```

Restart the server after changing it.

### ⚠ Please read this before turning online-mode off

With `online-mode=false` **anyone can join using any name — including yours.**
Someone could log in as `waquar5555` (or as you) and inherit your permissions if
you are an operator. Since it is your own server, do this:

1. Install an auth plugin so cracked players must log in:
   - Paper/Spigot: **AuthMeReloaded** or **xAuth**
   - Velocity/Limbo: **LimboAuth**, **EasyAuth**
   - Fabric: **SimpleAuth**
2. Turn the **whitelist** on: `whitelist=true`, then
   `whitelist add waquar5555` in the server console.
3. Never give the bot `op` unless you actually need it. If you do, protect it
   with the auth plugin and a strong password.

### If your server uses a whitelist

Offline-mode UUIDs are derived from the name, so whitelisting works normally:

```
whitelist add waquar5555
```

If the bot is kicked with *"You are not whitelisted!"*, that command fixes it.

### Custom chat prefixes

Some servers format chat as `[VIP] Waquar5555 » hello`, which vanilla parsing
cannot split. Set a regex in `.env` (group 1 = author, group 2 = message):

```ini
CHAT_AUTHOR_PATTERN=^(?:\[[^\]]+\]\s*)?(\w{3,16})\s*»\s*(.*)$
```

The dashboard then shows the name in its own coloured chip.

---

## Premium mode (online-mode=true servers)

Your own server is probably cracked, but if you ever point the bot at a premium
server:

```bash
# on the machine that runs the bot — it prints a URL + code, you type the code
# in any browser, tokens are cached in .mc-profiles/
npm run login:microsoft
```

then in `.env`:

```ini
MC_AUTH=microsoft
MC_USERNAME=<your real Minecraft username>
```

Notes:

- The Microsoft account **must own Minecraft Java Edition**.
- `.mc-profiles/` holds your account tokens — `chmod 700` it and never commit it
  (`.gitignore` already excludes it).
- On a headless VM the device-code flow works fine: open the printed URL on your
  phone, enter the code, done. Tokens are refreshed automatically afterwards.
- Premium account + cracked server: keep `MC_SKIP_VALIDATION=true`, otherwise the
  server never receives the session handshake.
- Premium account + online-mode server: set `MC_SKIP_VALIDATION=false`.

---

## Why "Failed to verify username!" happens

That kick means: **the server is online-mode=true and the bot tried an offline
login.** The dashboard detects it and shows exactly this explanation in the red
banner, along with the two ways out (turn `online-mode` off, or use
`MC_AUTH=microsoft`).

Other messages you may see and what they mean:

| Kick / error | Meaning | Fix |
|---|---|---|
| `Failed to verify username!` | online-mode server | see above |
| `Outdated client! Please use 1.20.4` | version mismatch | `MC_VERSION=1.20.4` |
| `You are not whitelisted!` | whitelist on | `whitelist add waquar5555` |
| `Timed out` / `ECONNREFUSED` / `ENOTFOUND` | cannot reach the server | check host/port, server up, VM outbound firewall |
| `Disconnected by server: §cYou are sending messages too fast` | chat spam | raise `SEND_COOLDOWN_MS` |
| `This server requires you to connect with Velocity` | Velocity proxy with modern forwarding | connect to the proxy address, or use the backend port with `MC_VERSION` pinned |

Full list: [troubleshooting.md](troubleshooting.md).
