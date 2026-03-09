# 🦀 Watchclaw

**Know when your OpenClaw agent dies — before anyone else does.**

Watchclaw watches your OpenClaw process and automation workflows. When something silently stops working, you get a Discord DM within 5 minutes.

---

## What it does

- Detects **silent failures** — when OpenClaw stops responding but shows as online
- Sends you a **Discord DM** the moment it notices something is wrong
- Shows a **live dashboard** with your agent's status, recent logs, and Claude Code prompts to fix issues
- Monitors **n8n / Make / Zapier** automations too (Week 2)

---

## Setup (5 minutes)

### Step 1 — Download and install

```bash
git clone https://github.com/yourusername/watchclaw.git
cd watchclaw
npm install
```

### Step 2 — Configure your environment

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill in:

**`WATCHCLAW_TOKEN`** — make up any secret password, e.g. `mytoken123`

**`DISCORD_WEBHOOK_URL`** — get this from Discord:
1. Open Discord
2. Go to a server you own (or create a private one just for yourself)
3. Server Settings → Integrations → Webhooks → New Webhook
4. Copy the webhook URL and paste it here

**`OPENCLAW_LOG_FILE`** — path to your OpenClaw log file.
Not sure where it is? Run this in Terminal:
```bash
find ~ -name "*.log" 2>/dev/null | grep -i openclaw
```

### Step 3 — Start the server

Open a Terminal window and run:
```bash
npm run server
```

You should see:
```
  🦀 Watchclaw Server running
  Port    : 3001
  Discord : ✓ configured
```

### Step 4 — Start the collector

Open a **second** Terminal window and run:
```bash
npm run collector
```

You should see:
```
  🦀 Watchclaw Collector starting...
  Agent : OpenClaw
  Server: http://localhost:3001

[09:42:01] ✓ Heartbeat sent — status: ok, running: true, memory: 142MB
```

### Step 5 — Test it works

With the collector running, stop your OpenClaw process. Within 5 minutes you should get a Discord DM.

---

## Keeping it running on your Mac

To run Watchclaw automatically in the background (so it survives restarts):

```bash
# Install pm2 (process manager)
npm install -g pm2

# Start server and collector with pm2
pm2 start server.js --name watchclaw-server
pm2 start collector.js --name watchclaw-collector

# Save so they restart on reboot
pm2 save
pm2 startup
```

---

## Deploying the server (optional)

The server can run on a free Railway or Render instance so it works even if your Mac is off.

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set environment variables in Railway dashboard (same as your `.env`)
4. Update `WATCHCLAW_SERVER_URL` in your local `.env` to your Railway URL

---

## Project structure

```
watchclaw/
├── collector.js    # Runs on your machine, watches OpenClaw, sends heartbeats
├── server.js       # Receives heartbeats, detects silence, sends Discord DMs
├── package.json
├── .env.example    # Environment variable template
└── README.md
```

---

## Roadmap

- [x] Silent failure detection + Discord alerts
- [x] Basic status dashboard
- [ ] Visual flow diagram (see which node in your chain broke)
- [ ] n8n / Make / Zapier webhook support
- [ ] "Ask Claude Code" prompts — one-click copy to fix issues
- [ ] Self-hosted dashboard
- [ ] Hosted version at watchclaw.app

---

## License

MIT — use it, fork it, build on it.
