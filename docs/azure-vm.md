# Hosting the bot on an Azure VM (GitHub Student Pack)

Your GitHub Student Pack gets you **Azure for Students**: $100 of credit for 12
months with **no credit card**, renewable every year you are still a student,
plus a set of free services — including **750 hours/month of a B1s Linux VM for
12 months**, which is enough to run this bot 24/7 for free.

- Offer details: <https://learn.microsoft.com/azure/education-hub/about-azure-for-students>
- Sign up: <https://azure.microsoft.com/free/students/> (verify with your college email, or through GitHub Education)

> Tip: if your Minecraft server already runs on a VPS, host the bot **there**.
> It uses ~80 MB of RAM, needs no extra ports, and costs nothing more.

---

## 1. Create the VM

1. Azure Portal → **Create a resource** → **Virtual machines** → **Create**.
2. Basics:
   | Field | Value |
   |---|---|
   | Subscription | Azure for Students |
   | Resource group | `minecraft-bot` (new) |
   | Virtual machine name | `mc-bot` |
   | Region | one close to your Minecraft server (lower ping) |
   | Image | **Ubuntu Server 24.04 LTS** |
   | Size | **B1s** (free 750 h/month) or **B2ats_v2** (~$4.50–7/month) |
3. Authentication: **SSH public key**.
   On your own computer:
   ```bash
   ssh-keygen -t ed25519 -C "azure-mc-bot"     # keep the private key safe
   cat ~/.ssh/id_ed25519.pub                   # paste this into the portal
   ```
   Username: `azureuser`.
4. Inbound port rules: **Allow selected ports** → tick **SSH (22)** and
   **HTTP (80)**. Add the dashboard port later if you want to expose it directly
   (see step 4 below).
5. Review + create → wait ~1 minute → copy the **public IP**.

Optional but useful: VM → **Networking → Network settings → DNS name label** →
set something like `mc-bot-waquar`. You now have a free hostname
(`mc-bot-waquar.<region>.cloudapp.azure.com`) that survives IP changes.

## 2. First login

```bash
ssh azureuser@<your-vm-public-ip>
```

## 3. Install everything in one command

```bash
curl -fsSL https://raw.githubusercontent.com/WaquarShaikh5555/minecraft-bots/main/deploy/setup-azure-vm.sh \
  | sudo bash -s -- --bot-name waquar5555 --server world.arterex.me:25565 --auth offline
```

The script installs Node 22, creates a locked-down `minecraft` service user,
clones the repo to `/opt/minecraft-bots`, writes a `.env` with a **generated
chat token (write it down — it is printed once)**, and installs a systemd
service that restarts the bot on crash and on boot.

Useful flags: `--port 8080`, `--tunnel` (free HTTPS via Cloudflare, see
[free-hosting.md](free-hosting.md)), `--allow-switch` (let the site move the bot
between servers), `--auth microsoft`.

Check it:

```bash
systemctl status minecraft-bot
journalctl -u minecraft-bot -f            # live bot logs
curl -s localhost:8080/healthz            # {"ok":true,"phase":"online",...}
```

## 4. Let your browser reach the dashboard

The bot only needs **outbound** TCP 25565 to the Minecraft server — no inbound
Minecraft ports. For the website you have three choices:

| Option | Cost | URL | Notes |
|---|---|---|---|
| **Cloudflare tunnel** (recommended) | free | `https://bot.arterex.me` or a `*.trycloudflare.com` URL | No open ports, free TLS, WebSockets work |
| **nginx + certbot** | free | `https://bot.arterex.me` | Needs DNS A record + ports 80/443 in the NSG |
| **Raw port** | free | `http://<vm-ip>:8080` | No TLS. Fine for personal use; a GitHub-Pages site cannot talk to it (browsers block `ws://` from `https://`) |

For the raw port: VM → Networking → **Create port rule → Inbound** → TCP `8080`,
source `Any` (or your IP only, which is safer). Then also run
`sudo ufw allow 8080/tcp` if you enabled ufw.

Full walkthrough for each option: [free-hosting.md](free-hosting.md).

## 5. Auto-deploy from GitHub

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Example |
|---|---|
| `VM_HOST` | `20.40.11.7` or `mc-bot-waquar.westus.cloudapp.azure.com` |
| `VM_USER` | `azureuser` |
| `VM_SSH_KEY` | the **private** key that matches the VM's authorized_keys |
| `VM_PORT` | `22` (optional) |

Push to `main` → `.github/workflows/deploy.yml` runs the tests, SSHes in, pulls,
reinstalls dependencies if `package.json` changed, and restarts the service.
Until the secrets exist the workflow simply skips the deploy step.

## 6. Day-to-day commands

```bash
sudo systemctl restart minecraft-bot      # after changing .env
sudo systemctl stop minecraft-bot         # stop the bot
sudo nano /opt/minecraft-bots/.env        # change server, name, token…
tail -f /opt/minecraft-bots/data/chat.jsonl   # raw chat archive
```

## 7. Keep the bill at zero

- **Stop (deallocate)** the VM when you are not using it: compute charges stop,
  the disk (a few cents/GB-month) and the public IP keep a tiny charge.
- Set a **budget alert**: Cost Management → Budgets → $5/month → email you.
- Student accounts have a **spending limit**, so services pause instead of
  billing you when the $100 runs out. Re-verify each year for another $100.
- Watch RAM: `B1s` is 1 GiB. This app idles around 120–200 MB, so you are fine,
  but do not co-host a Minecraft **server** on it.

## When the free year ends

Genuinely-free alternatives for a 24/7 bot:

- **Oracle Cloud Always Free** — 4 ARM cores / 24 GB RAM, free forever, no card
  charge. The best long-term option for a bot like this.
- **A Raspberry Pi / old laptop at home** — `node src/index.js` and a free
  Cloudflare tunnel. Costs nothing, needs your home network to stay up.
- **Google Cloud e2-micro** — free forever in 3 US regions (needs a card).

Anything that runs Node 22+ works (Mineflayer requires it); the whole `deploy/` folder is portable.
