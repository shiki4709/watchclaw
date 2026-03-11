// watchclaw/collector.js
// Runs on your Mac alongside OpenClaw.
// Every 60s: checks if OpenClaw is alive, reads recent logs, sends heartbeat to server.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // URL of your Watchclaw server (change to your deployed URL later)
  serverUrl: process.env.WATCHCLAW_SERVER_URL || 'http://localhost:3001',

  // Secret token so only your collector can talk to your server
  token: process.env.WATCHCLAW_TOKEN || 'changeme',

  // Name for this agent (shows up in dashboard + Discord DM)
  agentName: process.env.AGENT_NAME || 'OpenClaw',

  // How often to send a heartbeat (ms)
  intervalMs: 60_000,

  // Path to OpenClaw log file — adjust to match your setup
  // Common locations:
  //   ~/.openclaw/logs/openclaw.log
  //   ~/Library/Logs/openclaw.log
  //   ./openclaw.log  (if run from project dir)
  // Log directory — the collector will find today's log file automatically
  logDir: process.env.OPENCLAW_LOG_DIR || '/tmp/openclaw',
  logFilePattern: process.env.OPENCLAW_LOG_FILE || '', // if set, use this exact file instead

  // How many recent log lines to send with each heartbeat
  logLines: 20,

  // OpenClaw gateway health endpoint — used to detect silent failures
  // (process running but not responding to requests)
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18792/',
  gatewayTimeoutMs: 5000,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Resolve the current log file (OpenClaw rotates daily: openclaw-YYYY-MM-DD.log)
function getCurrentLogFile() {
  if (CONFIG.logFilePattern) return CONFIG.logFilePattern;
  try {
    // Find the most recently modified openclaw log file
    const files = fs.readdirSync(CONFIG.logDir)
      .filter(f => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(CONFIG.logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(CONFIG.logDir, files[0].name) : null;
  } catch {
    return null;
  }
}

// Check if the openclaw process is currently running
function isOpenClawRunning() {
  try {
    const result = execSync('pgrep -f "openclaw"', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return result.trim().length > 0;
  } catch {
    return false; // pgrep returns exit code 1 if nothing found
  }
}

// Read the last N lines from a file
function tailFile(filePath, lines = 20) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const result = execSync(`tail -n ${lines} "${filePath}"`, { encoding: 'utf8' });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Extract errors and warnings from log lines
function parseLogEvents(lines) {
  const events = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    let level = 'info';
    if (lower.includes('error') || lower.includes('err') || lower.includes('fatal')) level = 'error';
    else if (lower.includes('warn') || lower.includes('warning')) level = 'warn';

    // Try to extract a timestamp from common log formats
    const tsMatch = line.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/);
    events.push({
      level,
      msg: line.substring(0, 200), // cap length
      time: tsMatch ? tsMatch[0] : new Date().toISOString(),
    });
  }
  return events;
}

// Get memory usage of openclaw process (optional, best-effort)
function getProcessMemory() {
  try {
    const result = execSync('ps aux | grep -i "[o]penclaw"', { encoding: 'utf8' });
    const line = result.trim().split('\n')[0];
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const rss = parseFloat(parts[5]); // RSS in KB
    return Math.round(rss / 1024); // return MB
  } catch {
    return null;
  }
}

// Check if the OpenClaw gateway is actually responding to HTTP requests
async function isGatewayResponding() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.gatewayTimeoutMs);
    const res = await fetch(CONFIG.gatewayUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ── AGENT STRUCTURE AUTO-DETECTION ────────────────────────────────────────────

// Known model pricing (cost per million tokens)
const MODEL_PRICING = {
  'gemini-3-flash':         { input: 0.10,  output: 0.40, provider: 'google',    name: 'Gemini 3 Flash' },
  'gemini-3-flash-preview': { input: 0.10,  output: 0.40, provider: 'google',    name: 'Gemini 3 Flash' },
  'gemini-2.5-flash':       { input: 0.15,  output: 0.60, provider: 'google',    name: 'Gemini 2.5 Flash' },
  'gemini-2.5-pro':         { input: 1.25,  output: 10.0, provider: 'google',    name: 'Gemini 2.5 Pro' },
  'claude-sonnet-4-6':      { input: 3.00,  output: 15.0, provider: 'anthropic', name: 'Claude Sonnet 4.6' },
  'claude-opus-4-6':        { input: 15.0,  output: 75.0, provider: 'anthropic', name: 'Claude Opus 4.6' },
  'claude-haiku-4-5':       { input: 0.80,  output: 4.00, provider: 'anthropic', name: 'Claude Haiku 4.5' },
};

function detectAgentStructure() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
  const cronPath = path.join(homeDir, '.openclaw', 'cron', 'jobs.json');

  const structure = {
    agent: { id: CONFIG.agentName.toLowerCase().replace(/[^a-z0-9]/g, ''), name: CONFIG.agentName, emoji: '🦞', description: '' },
    model: null,
    channels: [],
    automations: [],
  };

  // Read OpenClaw config
  let ocConfig = null;
  try {
    ocConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`[detect] ✓ Read OpenClaw config from ${configPath}`);
  } catch {
    console.log(`[detect] ✗ Could not read ${configPath} — using defaults`);
    return structure;
  }

  // Detect primary model
  const primaryModel = ocConfig.agents?.defaults?.model?.primary || '';
  // primaryModel format: "google/gemini-3-flash" or "anthropic/claude-sonnet-4-6"
  const modelParts = primaryModel.split('/');
  const provider = modelParts[0] || 'unknown';
  const modelId = modelParts[1] || primaryModel;
  const pricing = MODEL_PRICING[modelId] || null;

  structure.model = {
    id: modelId,
    name: pricing ? pricing.name : modelId,
    provider: pricing ? pricing.provider : provider,
    costPerMillionInput: pricing ? pricing.input : 0,
    costPerMillionOutput: pricing ? pricing.output : 0,
  };

  // Detect channels from plugins.entries
  const plugins = ocConfig.plugins?.entries || {};
  const channelConfigs = ocConfig.channels || {};
  const channelEmojis = { whatsapp: '📱', discord: '💬', telegram: '✈️', slack: '💼', signal: '🔒' };
  const channelSubs   = { whatsapp: 'web session', discord: 'gateway · bot', telegram: 'bot', slack: 'workspace', signal: 'linked device' };

  for (const [chId, chCfg] of Object.entries(plugins)) {
    if (chCfg.enabled === false) continue;
    const chDetail = channelConfigs[chId] || {};
    structure.channels.push({
      id: chId,
      name: chId.charAt(0).toUpperCase() + chId.slice(1),
      emoji: channelEmojis[chId] || '📡',
      sub: channelSubs[chId] || (chDetail.groupPolicy ? `policy: ${chDetail.groupPolicy}` : 'channel'),
    });
  }

  // Build description from channels
  if (structure.channels.length > 0) {
    structure.agent.description = structure.channels.map(c => c.name).join(' & ') + ' automation gateway';
  }

  // Detect cron jobs as automations
  try {
    const cronData = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
    const jobs = cronData.jobs || [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      // Parse cron schedule for human-readable sub
      let schedDesc = job.schedule?.expr || '';
      if (schedDesc === '0 8 * * *') schedDesc = 'daily at 8 AM';
      else if (schedDesc.startsWith('*/')) schedDesc = `every ${schedDesc.split('/')[1]} mins`;

      structure.automations.push({
        id: job.id.substring(0, 8), // short ID
        name: job.name || 'Cron Job',
        emoji: '⏰',
        sub: schedDesc + (job.delivery?.channel ? ` → ${job.delivery.channel}` : ''),
      });
    }
    if (jobs.length > 0) console.log(`[detect] ✓ Found ${jobs.length} cron job(s)`);
  } catch {
    // No cron jobs — that's fine
  }

  console.log(`[detect] Agent: ${structure.agent.name}`);
  console.log(`[detect] Model: ${structure.model.name} (${structure.model.provider})`);
  console.log(`[detect] Channels: ${structure.channels.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[detect] Automations: ${structure.automations.map(a => a.name).join(', ') || 'none'}`);

  return structure;
}

// Detect structure on startup
let agentStructure = null;
let structureSent = false;

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  const running   = isOpenClawRunning();
  const logFile   = getCurrentLogFile();
  const logLines  = logFile ? tailFile(logFile, CONFIG.logLines) : [];
  const events    = parseLogEvents(logLines);
  const memoryMb  = getProcessMemory();

  // Check gateway responsiveness (only if process is running)
  let gatewayResponding = null;
  if (running) {
    gatewayResponding = await isGatewayResponding();
  }

  // Check for subsystem crash loops in recent logs
  const crashLoopLines = logLines.filter(l => l.includes('restarts/hour limit, skipping'));
  const subsystemDown = crashLoopLines.length > 0;

  // Determine status from recent log events + gateway health + subsystem health
  const recentErrors = events.filter(e => e.level === 'error').length;
  const recentWarns  = events.filter(e => e.level === 'warn').length;
  let status = 'ok';
  let statusMsg = null;
  if (!running) {
    status = 'err';
  } else if (subsystemDown) {
    status = 'err';
    statusMsg = 'subsystem crash loop — hit restart limit';
  } else if (gatewayResponding === false) {
    status = 'warn';
    statusMsg = 'process running but gateway not responding';
  } else if (recentErrors) {
    status = 'err';
  } else if (recentWarns) {
    status = 'warn';
  }

  const payload = {
    agent:     CONFIG.agentName,
    token:     CONFIG.token,
    timestamp: new Date().toISOString(),
    status,
    statusMsg,
    running,
    gatewayResponding,
    memoryMb,
    recentEvents: events.slice(-10), // last 10 parsed events
    rawLogTail:   logLines.slice(-5), // last 5 raw lines for debugging
  };

  // Include agent structure on first heartbeat so server can auto-build config.json
  if (!structureSent && agentStructure) {
    payload.agentStructure = agentStructure;
  }

  try {
    const res = await fetch(`${CONFIG.serverUrl}/heartbeat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 8000,
    });

    if (res.ok) {
      const now = new Date().toLocaleTimeString();
      const gwTag = gatewayResponding === null ? '' : gatewayResponding ? ', gw: ok' : ', gw: DOWN';
      console.log(`[${now}] ✓ Heartbeat sent — status: ${status}, running: ${running}, memory: ${memoryMb ?? '?'}MB${gwTag}`);
      if (!structureSent && agentStructure) {
        structureSent = true;
        console.log('[detect] ✓ Agent structure sent to server');
      }
    } else {
      console.error(`[heartbeat] Server returned ${res.status}`);
    }
  } catch (err) {
    // Server unreachable — log locally but don't crash
    console.error(`[heartbeat] Could not reach server: ${err.message}`);
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

console.log('');
console.log('  🦀 Watchclaw Collector starting...');
console.log(`  Agent : ${CONFIG.agentName}`);
console.log(`  Server: ${CONFIG.serverUrl}`);
console.log(`  Logs  : ${CONFIG.logFilePattern || CONFIG.logDir + '/openclaw-<date>.log'}`);
console.log(`  Gateway: ${CONFIG.gatewayUrl}`);
console.log(`  Ping  : every ${CONFIG.intervalMs / 1000}s`);
console.log('');

// Auto-detect agent structure from OpenClaw config
agentStructure = detectAgentStructure();

// Send first heartbeat immediately, then on interval
sendHeartbeat();
setInterval(sendHeartbeat, CONFIG.intervalMs);
