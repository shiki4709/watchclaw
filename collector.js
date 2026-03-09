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
  logFile: process.env.OPENCLAW_LOG_FILE || path.join(process.env.HOME, '.openclaw', 'logs', 'openclaw.log'),

  // How many recent log lines to send with each heartbeat
  logLines: 20,
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

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

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  const running   = isOpenClawRunning();
  const logLines  = tailFile(CONFIG.logFile, CONFIG.logLines);
  const events    = parseLogEvents(logLines);
  const memoryMb  = getProcessMemory();

  // Determine status from recent log events
  const recentErrors = events.filter(e => e.level === 'error').length;
  const recentWarns  = events.filter(e => e.level === 'warn').length;
  let status = 'ok';
  if (!running)          status = 'err';
  else if (recentErrors) status = 'err';
  else if (recentWarns)  status = 'warn';

  const payload = {
    agent:     CONFIG.agentName,
    token:     CONFIG.token,
    timestamp: new Date().toISOString(),
    status,
    running,
    memoryMb,
    recentEvents: events.slice(-10), // last 10 parsed events
    rawLogTail:   logLines.slice(-5), // last 5 raw lines for debugging
  };

  try {
    const res = await fetch(`${CONFIG.serverUrl}/heartbeat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 8000,
    });

    if (res.ok) {
      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] ✓ Heartbeat sent — status: ${status}, running: ${running}, memory: ${memoryMb ?? '?'}MB`);
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
console.log(`  Logs  : ${CONFIG.logFile}`);
console.log(`  Ping  : every ${CONFIG.intervalMs / 1000}s`);
console.log('');

// Send first heartbeat immediately, then on interval
sendHeartbeat();
setInterval(sendHeartbeat, CONFIG.intervalMs);
