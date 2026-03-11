// watchclaw/server.js
// Receives heartbeats from collector.
// If no heartbeat for 5 minutes → send Discord DM.
// Serves a simple status API for the dashboard.

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const { execSync } = require('child_process');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  port:    process.env.PORT || 3001,
  token:   process.env.WATCHCLAW_TOKEN || 'changeme',

  // Your Discord webhook URL for DM alerts
  // Create one: Discord → User Settings → Advanced → Enable Developer Mode
  // Then: Server Settings → Integrations → Webhooks → New Webhook
  // Or use a Discord bot DM — see README for setup
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',

  // How long before we consider an agent dead (ms)
  deadAfterMs: 5 * 60 * 1000, // 5 minutes = 3 missed heartbeats

  // How often to check for dead agents (ms)
  checkIntervalMs: 60 * 1000,

  // Database file path
  dbPath: process.env.DB_PATH || path.join(__dirname, 'watchclaw.db'),
};

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(CONFIG.dbPath);

// Set up tables
db.exec(`
  CREATE TABLE IF NOT EXISTS heartbeats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent       TEXT NOT NULL,
    status      TEXT NOT NULL,
    running     INTEGER,
    memory_mb   INTEGER,
    timestamp   TEXT NOT NULL,
    raw_payload TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent      TEXT NOT NULL,
    level      TEXT NOT NULL,
    msg        TEXT NOT NULL,
    time       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent      TEXT NOT NULL,
    type       TEXT NOT NULL,
    msg        TEXT NOT NULL,
    sent_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent);
  CREATE INDEX IF NOT EXISTS idx_events_agent     ON events(agent);
`);

// Prepared statements
const insertHeartbeat = db.prepare(`
  INSERT INTO heartbeats (agent, status, running, memory_mb, timestamp, raw_payload)
  VALUES (@agent, @status, @running, @memory_mb, @timestamp, @raw_payload)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (agent, level, msg, time)
  VALUES (@agent, @level, @msg, @time)
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (agent, type, msg) VALUES (@agent, @type, @msg)
`);

const getLatestHeartbeat = db.prepare(`
  SELECT * FROM heartbeats WHERE agent = ? ORDER BY created_at DESC LIMIT 1
`);

const getRecentEvents = db.prepare(`
  SELECT * FROM events WHERE agent = ? ORDER BY created_at DESC LIMIT 20
`);

const getAllAgents = db.prepare(`
  SELECT agent, MAX(created_at) as last_seen, status
  FROM heartbeats GROUP BY agent
`);

// ── DISCORD ALERTS ────────────────────────────────────────────────────────────

// Track which agents we've already alerted about to avoid spam
const alertedAgents = new Set();       // silence-based alerts
const alertedDownAgents = new Set();   // consecutive-bad-heartbeat alerts
const consecutiveBadBeats = new Map(); // agent → count of consecutive bad heartbeats
const CONSECUTIVE_BAD_THRESHOLD = 3;

async function sendDiscordAlert(agent, message, alertType = 'dead') {
  if (!CONFIG.discordWebhook) {
    console.warn('[alert] No Discord webhook configured — skipping alert');
    console.warn(`[alert] Would have sent: ${message}`);
    return;
  }

  const payload = {
    content: null,
    embeds: [{
      title: `🚨 Watchclaw Alert — ${agent}`,
      description: message,
      color: 0xE53E3E, // red
      timestamp: new Date().toISOString(),
      footer: { text: 'Watchclaw • watchclaw.app' },
    }]
  };

  try {
    const res = await fetch(CONFIG.discordWebhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`[alert] ✓ Discord alert sent for ${agent}`);
      insertAlert.run({ agent, type: alertType, msg: message });
    } else {
      console.error(`[alert] Discord webhook returned ${res.status}`);
    }
  } catch (err) {
    console.error(`[alert] Failed to send Discord alert: ${err.message}`);
  }
}

// ── DEAD AGENT DETECTOR ───────────────────────────────────────────────────────

function checkForDeadAgents() {
  const agents = getAllAgents.all();
  const now = Date.now();

  for (const agent of agents) {
    const lastSeenMs = new Date(agent.last_seen + 'Z').getTime();
    const silenceMs  = now - lastSeenMs;
    const silenceMins = Math.round(silenceMs / 60000);

    if (silenceMs > CONFIG.deadAfterMs) {
      if (!alertedAgents.has(agent.agent)) {
        alertedAgents.add(agent.agent);
        const msg = `**${agent.agent}** has been silent for **${silenceMins} minutes**.\n\nLast heartbeat: ${agent.last_seen}\nLast status: ${agent.status}\n\nOpen your Watchclaw dashboard to diagnose.`;
        console.log(`[detector] ☠ ${agent.agent} is DEAD — silent for ${silenceMins}m`);
        sendDiscordAlert(agent.agent, msg);
      }
    } else {
      // Agent is alive again — clear alert so we can re-alert if it dies again
      if (alertedAgents.has(agent.agent)) {
        console.log(`[detector] ✓ ${agent.agent} is back online`);
        alertedAgents.delete(agent.agent);
      }
    }
  }
}

// ── EXPRESS SERVER ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Allow dashboard to fetch from this server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// GET / — serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'watchclaw-demo.html'));
});

// GET /config — serve the user's config.json
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'config.json'));
});

// POST /heartbeat — collector sends this every 60s
app.post('/heartbeat', (req, res) => {
  const { agent, token, status, running, memoryMb, timestamp, recentEvents, agentStructure } = req.body;

  // Verify token
  if (token !== CONFIG.token) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!agent || !status) {
    return res.status(400).json({ error: 'Missing agent or status' });
  }

  // Auto-generate config.json from agent structure (sent on first heartbeat)
  if (agentStructure) {
    try {
      const configPath = path.join(__dirname, 'config.json');
      const s = agentStructure;

      // Build flow layout from detected structure
      const lanes = [
        { id: 'automations',    label: 'AUTOMATIONS',    color: '#f6f0ff' },
        { id: 'agent',          label: 'AGENT',          color: '#eff8f3' },
        { id: 'infrastructure', label: 'INFRASTRUCTURE', color: '#eff6ff' },
      ];

      const flowNodes = [];
      const flowEdges = [];

      // Automation nodes in top lane
      s.automations.forEach((a, i) => {
        flowNodes.push({ id: a.id, lane: 'automations', col: i });
      });

      // Agent node in middle lane
      flowNodes.push({ id: s.agent.id, lane: 'agent', col: 0 });

      // Infrastructure nodes in bottom lane
      flowNodes.push({ id: 'model', lane: 'infrastructure', col: 0 });
      s.channels.forEach((ch, i) => {
        flowNodes.push({ id: ch.id, lane: 'infrastructure', col: i + 1 });
        // Edge from agent to each channel
        flowEdges.push({ from: s.agent.id, to: ch.id, label: 'messages', sourceHandle: 'bottom', targetHandle: 'top' });
      });

      // Edge from model to agent
      flowEdges.push({ from: 'model', to: s.agent.id, label: 'inference', sourceHandle: 'top', targetHandle: 'bottom' });

      // Edges from automations to agent
      s.automations.forEach(a => {
        flowEdges.push({ from: a.id, to: s.agent.id, label: 'data', sourceHandle: 'bottom', targetHandle: 'top' });
      });

      const newConfig = {
        agent: s.agent,
        model: s.model,
        channels: s.channels,
        automations: s.automations,
        flow: { lanes, nodes: flowNodes, edges: flowEdges },
      };

      // Only write if config.json doesn't exist or is the default template
      let shouldWrite = false;
      try {
        const existing = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        // Overwrite if the existing config has the same agent id (same setup, just updating)
        // or if it looks like the default template
        shouldWrite = (existing.agent?.id === s.agent.id) || !existing._autoGenerated;
      } catch {
        shouldWrite = true; // file doesn't exist
      }

      if (shouldWrite) {
        newConfig._autoGenerated = true;
        newConfig._generatedAt = new Date().toISOString();
        require('fs').writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n');
        console.log(`[config] ✓ Auto-generated config.json from agent structure`);
      }
    } catch (err) {
      console.error(`[config] Failed to auto-generate config.json: ${err.message}`);
    }
  }

  // Store heartbeat
  insertHeartbeat.run({
    agent,
    status,
    running: running ? 1 : 0,
    memory_mb: memoryMb || null,
    timestamp: timestamp || new Date().toISOString(),
    raw_payload: JSON.stringify(req.body),
  });

  // Store any error/warn events from the log tail
  if (Array.isArray(recentEvents)) {
    for (const ev of recentEvents) {
      if (ev.level === 'error' || ev.level === 'warn') {
        insertEvent.run({
          agent,
          level: ev.level,
          msg:   ev.msg?.substring(0, 500) || '',
          time:  ev.time || new Date().toISOString(),
        });
      }
    }
  }

  // Track consecutive bad heartbeats (status "err" or not running)
  const isBad = status === 'err' || !running;
  if (isBad) {
    const count = (consecutiveBadBeats.get(agent) || 0) + 1;
    consecutiveBadBeats.set(agent, count);

    if (count >= CONSECUTIVE_BAD_THRESHOLD && !alertedDownAgents.has(agent)) {
      alertedDownAgents.add(agent);
      const msg = `**${agent}** has reported **${count} consecutive bad heartbeats**.\n\nStatus: \`${status}\`\nRunning: \`${running}\`\n\nThe process appears to be down. Open your Watchclaw dashboard to diagnose.`;
      console.log(`[detector] ⚠ ${agent} — ${count} consecutive bad heartbeats, sending alert`);
      sendDiscordAlert(agent, msg, 'down');
    }
  } else {
    // Agent recovered — reset counter and clear alert so we can re-alert
    if (consecutiveBadBeats.get(agent) > 0) {
      consecutiveBadBeats.set(agent, 0);
    }
    if (alertedDownAgents.has(agent)) {
      console.log(`[detector] ✓ ${agent} recovered — clearing down alert`);
      alertedDownAgents.delete(agent);
    }
  }

  console.log(`[${new Date().toLocaleTimeString()}] ♥ ${agent} — ${status} — running: ${running}`);
  res.json({ ok: true, received: new Date().toISOString() });
});

// GET /status — dashboard polls this for current state
app.get('/status', (req, res) => {
  const agents = getAllAgents.all();
  const now = Date.now();

  const result = agents.map(a => {
    const lastSeenMs = new Date(a.last_seen + 'Z').getTime();
    const silenceMs  = now - lastSeenMs;
    const latest     = getLatestHeartbeat.get(a.agent);
    const events     = getRecentEvents.all(a.agent);

    return {
      agent:      a.agent,
      status:     silenceMs > CONFIG.deadAfterMs ? 'dead' : a.status,
      lastSeen:   a.last_seen,
      silenceSecs: Math.round(silenceMs / 1000),
      running:    latest?.running === 1,
      memoryMb:   latest?.memory_mb,
      recentEvents: events.slice(0, 10),
    };
  });

  res.json({ agents: result, checkedAt: new Date().toISOString() });
});

// GET /events/:agent — recent log events for a specific agent
app.get('/events/:agent', (req, res) => {
  const events = getRecentEvents.all(req.params.agent);
  res.json({ events });
});

// GET /gateway — live check of the OpenClaw gateway process
app.get('/gateway', (req, res) => {
  try {
    // Find the openclaw-gateway process
    const psOut = execSync('ps aux', { encoding: 'utf8', timeout: 5000 });
    const lines = psOut.split('\n').filter(l => /openclaw/i.test(l) && !/grep/i.test(l));

    if (lines.length === 0) {
      return res.json({ running: false, pid: null, memoryMb: null, cpuPercent: null, uptimeSeconds: null });
    }

    // Parse the first matching line: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
    const parts = lines[0].trim().split(/\s+/);
    const pid = parseInt(parts[1], 10);
    const cpuPercent = parseFloat(parts[2]);
    const rssMb = Math.round(parseInt(parts[5], 10) / 1024);

    // Get process uptime via ps -o etime=
    let uptimeSeconds = null;
    try {
      const etime = execSync(`ps -p ${pid} -o etime=`, { encoding: 'utf8', timeout: 3000 }).trim();
      // etime format: [[dd-]hh:]mm:ss
      const etParts = etime.replace(/-/g, ':').split(':').reverse().map(Number);
      uptimeSeconds = (etParts[0] || 0) + (etParts[1] || 0) * 60 + (etParts[2] || 0) * 3600 + (etParts[3] || 0) * 86400;
    } catch {}

    res.json({ running: true, pid, memoryMb: rssMb, cpuPercent, uptimeSeconds });
  } catch (err) {
    res.json({ running: false, pid: null, memoryMb: null, cpuPercent: null, uptimeSeconds: null, error: err.message });
  }
});

// GET /health — simple liveness check
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log('');
  console.log('  🦀 Watchclaw Server running');
  console.log(`  Port    : ${CONFIG.port}`);
  console.log(`  Database: ${CONFIG.dbPath}`);
  console.log(`  Discord : ${CONFIG.discordWebhook ? '✓ configured' : '✗ not configured (set DISCORD_WEBHOOK_URL)'}`);
  console.log(`  Dead after: ${CONFIG.deadAfterMs / 60000} minutes of silence`);
  console.log('');
});

// Start the dead-agent detector loop
setInterval(checkForDeadAgents, CONFIG.checkIntervalMs);
console.log(`[detector] Checking for dead agents every ${CONFIG.checkIntervalMs / 1000}s`);
