/**
 * Driver-Fatigue Detection — Backend Server & Reverse Proxy
 *
 * Capabilities:
 * - SQLite Database via better-sqlite3 with WAL mode and schema auto-creation
 * - REST API: Authentication (JWT), Drivers, Trips, Telemetry Events, Stats, Reports (CSV), Settings
 * - WebSocket server on /ws for real-time telemetry, driver status & microsleep broadcasts
 * - ESP32-CAM MJPEG Reverse Proxy at /esp32/stream
 * - Static file serving with support for /public (Admin, Driver Station, Shared tokens)
 *
 * Zero external web framework dependencies (no Express). Native Node.js HTTP server.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { computeRiskScore } = require('./riskScore');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'drowsyguard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const JWT_SECRET = process.env.JWT_SECRET || 'drowsyguard-fleet-secure-secret-2026';

// ── Database Initialization ───────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema if tables do not exist
try {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);
} catch (err) {
  console.error('[db] Error executing schema.sql:', err.message);
}

// ── Load Config & ESP32 Proxy settings ────────────────────────────────────
let esp32StreamUrl = 'http://10.15.80.91:81/stream';
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.esp32Stream) esp32StreamUrl = cfg.esp32Stream.trim();
    }
  } catch (e) {
    console.warn('[config] Warning reading config.json:', e.message);
  }
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('esp32StreamUrl');
    if (row && row.value) esp32StreamUrl = row.value.trim();
  } catch (_) {}
}
loadConfig();

// ── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
};

// ── Helpers ────────────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

function parseMultipartBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=([^\s;]+)/i);
    if (!match) return reject(new Error('Missing multipart boundary'));
    const boundary = '--' + match[1].replace(/^["']|["']$/g, '');
    const chunks = [];
    let totalLen = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      totalLen += chunk.length;
      if (totalLen > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(boundary);
      const fields = {};
      const files = {};
      let pos = 0;
      while (pos < buffer.length) {
        const bIdx = buffer.indexOf(boundaryBuf, pos);
        if (bIdx === -1) break;
        const partStart = bIdx + boundaryBuf.length;
        if (buffer[partStart] === 0x2D && buffer[partStart + 1] === 0x2D) break; // "--"
        let headStart = partStart;
        if (buffer[headStart] === 0x0D && buffer[headStart + 1] === 0x0A) headStart += 2;
        const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headStart);
        if (headerEnd === -1) break;
        const headerStr = buffer.slice(headStart, headerEnd).toString('latin1');
        const dataStart = headerEnd + 4;
        const nextBoundary = buffer.indexOf(boundaryBuf, dataStart);
        if (nextBoundary === -1) break;
        let dataEnd = nextBoundary;
        if (buffer[dataEnd - 2] === 0x0D && buffer[dataEnd - 1] === 0x0A) dataEnd -= 2;
        const partData = buffer.slice(dataStart, dataEnd);

        const nameMatch = headerStr.match(/name="([^"]+)"/i);
        if (nameMatch) {
          const fieldName = nameMatch[1];
          const fnMatch = headerStr.match(/filename="([^"]+)"/i);
          if (fnMatch) {
            const ctMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);
            files[fieldName] = {
              filename: fnMatch[1],
              contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
              data: partData
            };
          } else {
            fields[fieldName] = partData.toString('utf8').trim();
          }
        }
        pos = nextBoundary;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message, status: statusCode });
}

function verifyAuth(req) {
  let token = '';
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    try {
      const parsedUrl = url.parse(req.url, true);
      if (parsedUrl.query && parsedUrl.query.token) {
        token = parsedUrl.query.token;
      }
    } catch (_) {}
  }
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ── ESP32 MJPEG Multi-Client Stream Engine ────────────────────────────────
const esp32Clients = new Set();
let esp32BroadcasterRunning = false;
let upstreamStreamReq = null;
let lastTuneTime = 0;

function autoTuneEsp32Camera(host, force = false) {
  const now = Date.now();
  if (!force && now - lastTuneTime < 60000) return;
  lastTuneTime = now;
  const tunes = [
    { var: 'quality', val: 10 },    // Low compression / sharp detail (was 30)
    { var: 'saturation', val: 1 }, // Vibrant natural colors (was -2)
    { var: 'contrast', val: 1 },   // Crisp edge definition (was 0)
    { var: 'brightness', val: 0 }, // Balanced dynamic range (was 1)
    { var: 'sharpness', val: 1 },  // Enhanced boundary sharpness
    { var: 'awb', val: 1 },        // Automatic white balance
    { var: 'vflip', val: 1 },      // Upright orientation
  ];
  for (const t of tunes) {
    http.get(`http://${host}/control?var=${t.var}&val=${t.val}`, () => {}).on('error', () => {});
  }
}

function startEsp32Broadcaster() {
  if (esp32BroadcasterRunning) return;
  esp32BroadcasterRunning = true;

  const parsed = url.parse(esp32StreamUrl);
  const host = parsed.hostname || '10.15.80.91';
  const port = parseInt(parsed.port || '81', 10);
  const streamPath = (parsed.path && parsed.path !== '/') ? parsed.path : '/stream';

  autoTuneEsp32Camera(host);

  console.log(`[esp32-proxy] Connecting to upstream MJPEG at http://${host}:${port}${streamPath}`);
  upstreamStreamReq = http.get({
    host,
    port,
    path: streamPath,
    timeout: 6000,
  }, (upstreamRes) => {
    if (upstreamRes.statusCode !== 200) {
      console.warn(`[esp32-proxy] Upstream status: ${upstreamRes.statusCode}`);
      stopEsp32Broadcaster();
      if (esp32Clients.size > 0) setTimeout(startEsp32Broadcaster, 2000);
      return;
    }

    console.log('[esp32-proxy] Upstream connected! Piping MJPEG frames to', esp32Clients.size, 'clients.');

    upstreamRes.on('data', (chunk) => {
      if (esp32Clients.size === 0) {
        stopEsp32Broadcaster();
        return;
      }
      for (const clientRes of esp32Clients) {
        if (clientRes.writableEnded || clientRes.destroyed) {
          esp32Clients.delete(clientRes);
          continue;
        }
        // Socket backpressure check
        if (clientRes.writableLength > 200000) {
          continue;
        }
        try {
          clientRes.write(chunk);
        } catch (_) {
          esp32Clients.delete(clientRes);
        }
      }
    });

    upstreamRes.on('end', () => {
      console.warn('[esp32-proxy] Upstream stream ended');
      stopEsp32Broadcaster();
      if (esp32Clients.size > 0) setTimeout(startEsp32Broadcaster, 1000);
    });

    upstreamRes.on('error', (err) => {
      console.error('[esp32-proxy] Upstream error:', err.message);
      stopEsp32Broadcaster();
      if (esp32Clients.size > 0) setTimeout(startEsp32Broadcaster, 1500);
    });
  });

  upstreamStreamReq.on('error', (err) => {
    console.error('[esp32-proxy] Connection error:', err.message);
    stopEsp32Broadcaster();
    if (esp32Clients.size > 0) setTimeout(startEsp32Broadcaster, 2000);
  });

  upstreamStreamReq.on('timeout', () => {
    console.warn('[esp32-proxy] Upstream stream timeout');
    upstreamStreamReq.destroy();
    stopEsp32Broadcaster();
    if (esp32Clients.size > 0) setTimeout(startEsp32Broadcaster, 2000);
  });
}

function stopEsp32Broadcaster() {
  esp32BroadcasterRunning = false;
  if (upstreamStreamReq) {
    try { upstreamStreamReq.destroy(); } catch (_) {}
    upstreamStreamReq = null;
  }
}

function proxyEsp32(req, res) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace;boundary=123456789000000000000987654321',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  esp32Clients.add(res);
  req.on('close', () => {
    esp32Clients.delete(res);
    if (esp32Clients.size === 0) {
      stopEsp32Broadcaster();
    }
  });

  startEsp32Broadcaster();
}

// ── Create HTTP Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // 1. ESP32 Stream Proxy
  if (pathname === '/esp32/stream') {
    return proxyEsp32(req, res);
  }

  // 2. REST API Routes
  if (pathname.startsWith('/api/')) {
    try {
      await handleApiRoute(req, res, pathname, method, parsedUrl.query);
    } catch (err) {
      console.error('[api-error]', method, pathname, err);
      sendError(res, 500, err.message || 'Internal Server Error');
    }
    return;
  }

  // 3. Static File Serving
  let filePath = '';
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  } else if (pathname === '/login' || pathname === '/login.html') {
    filePath = path.join(PUBLIC_DIR, 'login.html');
  } else if (pathname === '/admin/login' || pathname === '/admin/login.html') {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  } else if (pathname === '/admin' || pathname === '/admin/') {
    filePath = path.join(PUBLIC_DIR, 'admin', 'index.html');
  } else if (pathname === '/driver' || pathname === '/driver/') {
    filePath = path.join(PUBLIC_DIR, 'driver', 'index.html');
  } else if (pathname === '/standalone' || pathname === '/standalone.html') {
    filePath = path.join(ROOT, 'standalone.html');
  } else {
    // Try public directory first, then root directory
    const publicCandidate = path.join(PUBLIC_DIR, pathname);
    const rootCandidate = path.join(ROOT, pathname);

    if (fs.existsSync(publicCandidate) && fs.statSync(publicCandidate).isFile()) {
      filePath = publicCandidate;
    } else if (fs.existsSync(rootCandidate) && fs.statSync(rootCandidate).isFile()) {
      filePath = rootCandidate;
    }
  }

  if (filePath && fs.existsSync(filePath)) {
    return serveStatic(res, filePath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

// ── WebSocket Server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const activeClients = new Set();

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  activeClients.add(ws);
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe') {
        ws.role = data.role || 'viewer';
        ws.driverId = data.driverId || null;
      } else if (data.type === 'heartbeat') {
        try {
          if (data.driverId) {
            db.prepare("UPDATE drivers SET status = ? WHERE id = ?").run(data.status || 'safe', data.driverId);
          }
          if (data.tripId) {
            db.prepare("UPDATE trips SET avg_perclos = ?, duration_seconds = MAX(0, ROUND(strftime('%s', 'now') - strftime('%s', start_time))) WHERE id = ?").run(
              typeof data.perclos === 'number' ? data.perclos : 0,
              data.tripId
            );
          }
        } catch (_) {}

        // Forward live telemetry to all connected clients
        broadcastWs({
          type: 'live_telemetry',
          driverId: data.driverId,
          tripId: data.tripId,
          status: data.status,
          perclos: data.perclos,
          ear: data.ear,
          mar: data.mar,
          blinkRate: data.blinkRate,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    activeClients.delete(ws);
  });
});

function broadcastWs(data) {
  const payload = JSON.stringify(data);
  for (const client of activeClients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// ── REST API Handler ──────────────────────────────────────────────────────
async function handleApiRoute(req, res, pathname, method, query) {
  // ── Authentication Routes ───────────────────────────────────────────────
  if ((pathname === '/api/auth/admin-login' || pathname === '/api/auth/login') && method === 'POST') {
    const body = await readJsonBody(req);
    const { email, password } = body;
    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required');
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.trim().toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.company_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return sendJson(res, 200, {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }

  if (pathname === '/api/auth/driver-login' && method === 'POST') {
    const body = await readJsonBody(req);
    const { employee_id, pin } = body;
    if (!employee_id || !pin) {
      return sendError(res, 400, 'Employee ID and PIN are required');
    }

    const driver = db.prepare('SELECT * FROM drivers WHERE employee_id = ? AND is_active = 1').get(employee_id.trim().toUpperCase());
    if (!driver || !bcrypt.compareSync(String(pin).trim(), driver.pin_hash)) {
      return sendError(res, 401, 'Invalid Employee ID or PIN');
    }

    const calib = db.prepare('SELECT baseline_ear FROM calibration_profiles WHERE driver_id = ?').get(driver.id);

    const token = jwt.sign(
      { id: driver.id, employeeId: driver.employee_id, name: driver.name, role: 'driver', companyId: driver.company_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return sendJson(res, 200, {
      token,
      driver: {
        id: driver.id,
        employeeId: driver.employee_id,
        name: driver.name,
        vehicle: driver.vehicle,
        status: driver.status,
        baselineEar: calib ? calib.baseline_ear : null,
      },
    });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    if (auth.role === 'driver') {
      const driver = db.prepare('SELECT id, employee_id, name, vehicle, status FROM drivers WHERE id = ?').get(auth.id);
      if (!driver) return sendError(res, 404, 'Driver not found');
      return sendJson(res, 200, { role: 'driver', profile: driver });
    } else {
      const user = db.prepare('SELECT id, email, name, role, company_id FROM users WHERE id = ?').get(auth.id);
      if (!user) return sendError(res, 404, 'User not found');
      return sendJson(res, 200, { role: user.role, profile: user });
    }
  }

  // ── Driver Routes ───────────────────────────────────────────────────────
  if (pathname === '/api/drivers' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const drivers = db.prepare(`
      SELECT 
        d.id, d.employee_id, d.name, d.vehicle, d.status, d.is_active, d.created_at,
        c.baseline_ear,
        COALESCE((
          SELECT risk_score FROM trips WHERE driver_id = d.id ORDER BY id DESC LIMIT 1
        ), 0) AS last_risk_score,
        COALESCE((
          SELECT risk_level FROM trips WHERE driver_id = d.id ORDER BY id DESC LIMIT 1
        ), 'Low') AS last_risk_level,
        COALESCE((
          SELECT COUNT(*) FROM events 
          WHERE driver_id = d.id AND type = 'microsleep' 
            AND timestamp >= datetime('now', '-7 days')
        ), 0) AS microsleeps_7d,
        COALESCE((
          SELECT COUNT(*) FROM events 
          WHERE driver_id = d.id AND severity IN ('warning', 'danger', 'critical')
            AND timestamp >= datetime('now', '-7 days')
        ), 0) AS alerts_7d,
        (SELECT MAX(start_time) FROM trips WHERE driver_id = d.id) AS last_trip_time
      FROM drivers d
      LEFT JOIN calibration_profiles c ON c.driver_id = d.id
      ORDER BY d.id ASC
    `).all();

    return sendJson(res, 200, { drivers });
  }

  if (pathname === '/api/drivers' && method === 'POST') {
    const auth = verifyAuth(req);
    if (!auth || (auth.role !== 'admin' && auth.role !== 'manager')) {
      return sendError(res, 403, 'Forbidden');
    }

    const body = await readJsonBody(req);
    const { employee_id, name, pin, vehicle, baseline_ear } = body;
    if (!employee_id || !name || !pin || !vehicle) {
      return sendError(res, 400, 'employee_id, name, pin, and vehicle are required');
    }

    const pinHash = bcrypt.hashSync(String(pin).trim(), 8);
    try {
      const insert = db.prepare(`
        INSERT INTO drivers (company_id, employee_id, name, pin_hash, vehicle, status, is_active)
        VALUES (?, ?, ?, ?, ?, 'offline', 1)
      `);
      const result = insert.run(auth.companyId || 1, employee_id.trim().toUpperCase(), name.trim(), pinHash, vehicle.trim());
      const driverId = result.lastInsertRowid;

      if (baseline_ear) {
        db.prepare('INSERT OR REPLACE INTO calibration_profiles (driver_id, baseline_ear) VALUES (?, ?)').run(driverId, parseFloat(baseline_ear));
      }

      return sendJson(res, 201, { message: 'Driver created', id: driverId });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return sendError(res, 409, 'Employee ID already exists');
      }
      throw err;
    }
  }

  // Parameterized driver route (/api/drivers/:id)
  const driverMatch = pathname.match(/^\/api\/drivers\/(\d+)$/);
  if (driverMatch) {
    const driverId = parseInt(driverMatch[1], 10);
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    if (method === 'GET') {
      const driver = db.prepare(`
        SELECT d.id, d.employee_id, d.name, d.vehicle, d.status, d.is_active, d.created_at,
               c.baseline_ear, c.calibrated_at
        FROM drivers d
        LEFT JOIN calibration_profiles c ON c.driver_id = d.id
        WHERE d.id = ?
      `).get(driverId);

      if (!driver) return sendError(res, 404, 'Driver not found');

      // Lifetime overview stats
      const stats = db.prepare(`
        SELECT 
          COUNT(*) AS total_trips,
          COALESCE(SUM(duration_seconds), 0) AS total_seconds,
          COALESCE(SUM(warning_count), 0) AS total_warnings,
          COALESCE(SUM(danger_count), 0) AS total_dangers,
          COALESCE(SUM(microsleep_count), 0) AS total_microsleeps,
          COALESCE(SUM(yawn_count), 0) AS total_yawns,
          COALESCE(AVG(avg_perclos), 0.0) AS overall_avg_perclos,
          COALESCE(AVG(risk_score), 0) AS avg_risk_score
        FROM trips
        WHERE driver_id = ? AND status = 'completed'
      `).get(driverId);

      // 30-day incident counts for progress chart
      const trend30d = db.prepare(`
        SELECT date(timestamp) AS day,
               COUNT(*) AS alert_count,
               SUM(CASE WHEN type = 'microsleep' THEN 1 ELSE 0 END) AS microsleeps
        FROM events
        WHERE driver_id = ? AND timestamp >= datetime('now', '-30 days')
        GROUP BY day
        ORDER BY day ASC
      `).all(driverId);

      // Recent incidents (last 10)
      const incidents = db.prepare(`
        SELECT id, trip_id, timestamp, type, severity, duration_ms, ear, mar, perclos, status, notes
        FROM events
        WHERE driver_id = ? AND type != 'heartbeat'
        ORDER BY timestamp DESC
        LIMIT 10
      `).all(driverId);

      // Recent trips (last 10)
      const trips = db.prepare(`
        SELECT id, start_time, end_time, status, duration_seconds, warning_count, danger_count, microsleep_count, avg_perclos, risk_score, risk_level
        FROM trips
        WHERE driver_id = ?
        ORDER BY start_time DESC
        LIMIT 10
      `).all(driverId);

      return sendJson(res, 200, { driver, stats, trend30d, incidents, trips });
    }

    if (method === 'PUT') {
      if (auth.role !== 'admin' && auth.role !== 'manager') return sendError(res, 403, 'Forbidden');
      const body = await readJsonBody(req);
      const { name, vehicle, is_active, pin } = body;

      if (pin) {
        const pinHash = bcrypt.hashSync(String(pin).trim(), 8);
        db.prepare('UPDATE drivers SET pin_hash = ? WHERE id = ?').run(pinHash, driverId);
      }

      db.prepare(`
        UPDATE drivers 
        SET name = COALESCE(?, name),
            vehicle = COALESCE(?, vehicle),
            is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(name || null, vehicle || null, is_active !== undefined ? is_active : null, driverId);

      return sendJson(res, 200, { message: 'Driver updated' });
    }

    if (method === 'DELETE') {
      if (auth.role !== 'admin') return sendError(res, 403, 'Forbidden');
      db.prepare("UPDATE drivers SET is_active = 0, status = 'offline' WHERE id = ?").run(driverId);
      return sendJson(res, 200, { message: 'Driver deactivated' });
    }
  }

  // ── Trip Routes ─────────────────────────────────────────────────────────
  if (pathname === '/api/trips' && method === 'POST') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const body = await readJsonBody(req);
    const driverId = auth.role === 'driver' ? auth.id : body.driver_id;
    if (!driverId) return sendError(res, 400, 'driver_id is required');

    // Close any previous open trips for this driver
    db.prepare("UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE driver_id = ? AND status = 'active'").run(driverId);

    const startTime = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO trips (driver_id, start_time, status, duration_seconds)
      VALUES (?, ?, 'active', 0)
    `).run(driverId, startTime);

    db.prepare("UPDATE drivers SET status = 'safe' WHERE id = ?").run(driverId);

    broadcastWs({
      type: 'trip_started',
      tripId: result.lastInsertRowid,
      driverId,
      startTime,
    });

    return sendJson(res, 201, {
      tripId: result.lastInsertRowid,
      driverId,
      startTime,
      status: 'active',
    });
  }

  const endTripMatch = pathname.match(/^\/api\/trips\/(\d+)\/end$/);
  if (endTripMatch && method === 'PATCH') {
    const tripId = parseInt(endTripMatch[1], 10);
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    if (!trip) return sendError(res, 404, 'Trip not found');

    const endTime = new Date();
    const startTime = new Date(trip.start_time);
    const durationSeconds = Math.max(1, Math.round((endTime - startTime) / 1000));

    // Aggregate telemetry events for this trip
    const counts = db.prepare(`
      SELECT 
        COUNT(CASE WHEN type = 'warning' THEN 1 END) AS warnings,
        COUNT(CASE WHEN type = 'danger' THEN 1 END) AS dangers,
        COUNT(CASE WHEN type = 'microsleep' THEN 1 END) AS microsleeps,
        COUNT(CASE WHEN type = 'yawn' THEN 1 END) AS yawns,
        COALESCE(AVG(perclos), 0.0) AS avg_perclos
      FROM events
      WHERE trip_id = ?
    `).get(tripId);

    const { score, level } = computeRiskScore({
      microsleepCount: counts.microsleeps,
      dangerCount: counts.dangers,
      warningCount: counts.warnings,
      yawnCount: counts.yawns,
      avgPerclos: counts.avg_perclos,
      durationSeconds,
    });

    db.prepare(`
      UPDATE trips 
      SET end_time = ?,
          status = 'completed',
          duration_seconds = ?,
          warning_count = ?,
          danger_count = ?,
          microsleep_count = ?,
          yawn_count = ?,
          avg_perclos = ?,
          risk_score = ?,
          risk_level = ?
      WHERE id = ?
    `).run(
      endTime.toISOString(),
      durationSeconds,
      counts.warnings,
      counts.dangers,
      counts.microsleeps,
      counts.yawns,
      parseFloat(counts.avg_perclos.toFixed(3)),
      score,
      level,
      tripId
    );

    db.prepare("UPDATE drivers SET status = 'offline' WHERE id = ?").run(trip.driver_id);

    broadcastWs({
      type: 'trip_ended',
      tripId,
      driverId: trip.driver_id,
      durationSeconds,
      riskScore: score,
      riskLevel: level,
    });

    return sendJson(res, 200, {
      tripId,
      durationSeconds,
      riskScore: score,
      riskLevel: level,
      warnings: counts.warnings,
      dangers: counts.dangers,
      microsleeps: counts.microsleeps,
    });
  }

  // ── Event Ingestion ─────────────────────────────────────────────────────
  if (pathname === '/api/events/batch' && method === 'POST') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const body = await readJsonBody(req);
    const { trip_id, events } = body;
    if (!trip_id || !Array.isArray(events)) {
      return sendError(res, 400, 'trip_id and events array are required');
    }

    const trip = db.prepare('SELECT driver_id FROM trips WHERE id = ?').get(trip_id);
    if (!trip) return sendError(res, 404, 'Trip not found');

    const insertEvent = db.prepare(`
      INSERT INTO events (trip_id, driver_id, timestamp, type, severity, duration_ms, ear, mar, perclos, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')
    `);

    let highestSeverity = 'normal';
    let hadMicrosleep = false;

    const validTypes = ['heartbeat', 'eye_closure', 'yawn', 'head_nod', 'microsleep', 'warning', 'danger'];
    const validSeverities = ['normal', 'warning', 'danger', 'critical'];

    db.transaction(() => {
      for (const ev of events) {
        const ts = ev.timestamp || new Date().toISOString();
        let rawType = ev.type || 'heartbeat';
        let rawSeverity = ev.severity || 'normal';

        if (rawType === 'normal') rawType = 'heartbeat';
        const type = validTypes.includes(rawType) ? rawType : (rawSeverity === 'critical' ? 'microsleep' : (validTypes.includes(rawSeverity) ? rawSeverity : 'heartbeat'));
        const severity = validSeverities.includes(rawSeverity) ? rawSeverity : 'normal';

        const duration = ev.duration_ms || 0;
        const ear = ev.ear !== undefined ? parseFloat(ev.ear) : null;
        const mar = ev.mar !== undefined ? parseFloat(ev.mar) : null;
        const perclos = ev.perclos !== undefined ? parseFloat(ev.perclos) : null;

        insertEvent.run(trip_id, trip.driver_id, ts, type, severity, duration, ear, mar, perclos);

        if (severity === 'critical' || type === 'microsleep') {
          highestSeverity = 'microsleep';
          hadMicrosleep = true;
        } else if (severity === 'danger' && highestSeverity !== 'microsleep') {
          highestSeverity = 'danger';
        } else if (severity === 'warning' && highestSeverity === 'normal') {
          highestSeverity = 'warning';
        }
      }
    })();

    // Update driver live status in DB
    if (highestSeverity !== 'normal') {
      db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(highestSeverity, trip.driver_id);
    }

    // Broadcast critical alert to admin clients
    if (hadMicrosleep) {
      const driver = db.prepare('SELECT name, vehicle FROM drivers WHERE id = ?').get(trip.driver_id);
      broadcastWs({
        type: 'microsleep_alert',
        tripId: trip_id,
        driverId: trip.driver_id,
        driverName: driver ? driver.name : 'Unknown Driver',
        vehicle: driver ? driver.vehicle : 'Fleet Vehicle',
        timestamp: new Date().toISOString(),
      });
    }

    return sendJson(res, 200, { ingested: events.length });
  }

  // ── Stats Routes ────────────────────────────────────────────────────────
  if (pathname === '/api/stats/overview' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const activeDrivers = db.prepare("SELECT COUNT(*) AS count FROM drivers WHERE status != 'offline' AND is_active = 1").get().count;
    const microsleepsToday = db.prepare(`
      SELECT COUNT(*) AS count FROM events 
      WHERE type = 'microsleep' AND date(timestamp) = date('now')
    `).get().count;

    const microsleepsYesterday = db.prepare(`
      SELECT COUNT(*) AS count FROM events 
      WHERE type = 'microsleep' AND date(timestamp) = date('now', '-1 day')
    `).get().count;

    const totalAlertsToday = db.prepare(`
      SELECT COUNT(*) AS count FROM events 
      WHERE severity IN ('warning', 'danger', 'critical') AND date(timestamp) = date('now')
    `).get().count;

    const totalAlertsYesterday = db.prepare(`
      SELECT COUNT(*) AS count FROM events 
      WHERE severity IN ('warning', 'danger', 'critical') AND date(timestamp) = date('now', '-1 day')
    `).get().count;

    const avgRisk = db.prepare(`
      SELECT COALESCE(ROUND(AVG(risk_score)), 0) AS avg_score 
      FROM trips 
      WHERE start_time >= datetime('now', '-7 days')
    `).get().avg_score;

    return sendJson(res, 200, {
      activeDriversNow: activeDrivers,
      microsleepsToday,
      microsleepsTrend: microsleepsToday - microsleepsYesterday,
      totalAlertsToday,
      totalAlertsTrend: totalAlertsToday - totalAlertsYesterday,
      avgFleetRiskScore: avgRisk,
    });
  }

  if (pathname === '/api/stats/live' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const liveDrivers = db.prepare(`
      SELECT 
        d.id, d.employee_id, d.name, d.vehicle, d.status,
        t.id AS current_trip_id,
        t.start_time AS trip_start_time,
        COALESCE(ROUND((strftime('%s', 'now') - strftime('%s', t.start_time))), 0) AS trip_elapsed_seconds,
        COALESCE(t.avg_perclos, 0.0) AS perclos,
        COALESCE(t.warning_count, 0) AS warnings,
        COALESCE(t.danger_count, 0) AS dangers,
        COALESCE(t.microsleep_count, 0) AS microsleeps
      FROM drivers d
      JOIN trips t ON t.driver_id = d.id AND t.status = 'active'
      WHERE d.is_active = 1
      ORDER BY d.status DESC, d.name ASC
    `).all();

    return sendJson(res, 200, { activeDrivers: liveDrivers });
  }

  if (pathname === '/api/stats/alerts-over-time' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    // Last 14 days line chart
    const last14Days = db.prepare(`
      SELECT date(timestamp) AS day,
             COUNT(CASE WHEN severity = 'warning' THEN 1 END) AS warnings,
             COUNT(CASE WHEN severity = 'danger' THEN 1 END) AS dangers,
             COUNT(CASE WHEN type = 'microsleep' THEN 1 END) AS microsleeps,
             COUNT(*) AS total
      FROM events
      WHERE timestamp >= datetime('now', '-14 days') AND type != 'heartbeat'
      GROUP BY day
      ORDER BY day ASC
    `).all();

    // Severity split today (donut)
    const severityToday = db.prepare(`
      SELECT 
        COUNT(CASE WHEN severity = 'warning' THEN 1 END) AS warning,
        COUNT(CASE WHEN severity = 'danger' THEN 1 END) AS danger,
        COUNT(CASE WHEN severity = 'critical' OR type = 'microsleep' THEN 1 END) AS critical
      FROM events
      WHERE date(timestamp) = date('now') AND type != 'heartbeat'
    `).get();

    // Alerts by hour of day (bar chart)
    const hourlyAlerts = db.prepare(`
      SELECT strftime('%H', timestamp) AS hour, COUNT(*) AS count
      FROM events
      WHERE timestamp >= datetime('now', '-7 days') AND type != 'heartbeat'
      GROUP BY hour
      ORDER BY hour ASC
    `).all();

    return sendJson(res, 200, { last14Days, severityToday, hourlyAlerts });
  }

  // ── Alerts Routes ───────────────────────────────────────────────────────
  if (pathname === '/api/alerts' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    if (auth.role === 'driver') return sendError(res, 403, 'Forbidden');

    let sql = `
      SELECT 
        e.id,
        e.trip_id,
        e.driver_id,
        d.name AS driver_name,
        d.employee_id,
        d.vehicle,
        e.timestamp,
        e.type,
        e.severity,
        e.duration_ms,
        e.ear,
        e.mar,
        e.perclos,
        e.status,
        e.notes,
        e.acknowledged_at,
        u.name AS acknowledged_by_name
      FROM events e
      JOIN drivers d ON d.id = e.driver_id
      LEFT JOIN users u ON u.id = e.acknowledged_by
      WHERE e.type != 'heartbeat'
    `;
    const params = [];
    if (query.driver_id) {
      sql += ` AND (d.id = ? OR d.employee_id = ?) `;
      params.push(query.driver_id, query.driver_id);
    }
    if (query.status) {
      sql += ` AND e.status = ? `;
      params.push(query.status);
    }
    sql += ` ORDER BY e.timestamp DESC LIMIT 100 `;

    const alerts = db.prepare(sql).all(...params);
    return sendJson(res, 200, { alerts });
  }

  const alertAckMatch = pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
  if (alertAckMatch && (method === 'PATCH' || method === 'POST')) {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    // Admin, Manager, and Supervisor can acknowledge alerts
    if (auth.role !== 'admin' && auth.role !== 'manager' && auth.role !== 'supervisor') {
      return sendError(res, 403, 'Forbidden');
    }
    const alertId = parseInt(alertAckMatch[1], 10);
    const userId = (auth.role !== 'driver') ? auth.id : null;
    db.prepare(`
      UPDATE events 
      SET status = 'Acknowledged', acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, alertId);
    return sendJson(res, 200, { message: 'Alert acknowledged', alertId });
  }

  const alertDeleteMatch = pathname.match(/^\/api\/alerts\/(\d+)$/);
  if (alertDeleteMatch && method === 'DELETE') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    // Supervisors CANNOT delete alerts
    if (auth.role === 'supervisor') {
      return sendError(res, 403, 'Supervisors do not have permission to delete alerts');
    }
    if (auth.role !== 'admin' && auth.role !== 'manager') {
      return sendError(res, 403, 'Forbidden');
    }
    const alertId = parseInt(alertDeleteMatch[1], 10);
    db.prepare('DELETE FROM events WHERE id = ?').run(alertId);
    return sendJson(res, 200, { message: 'Alert deleted', alertId });
  }

  // ── Reports Route (CSV Export & Driver Filtering) ────────────────────────
  if (pathname === '/api/reports' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    if (auth.role === 'driver') return sendError(res, 403, 'Forbidden');

    let sql = `
      SELECT 
        t.id AS trip_id,
        d.id AS driver_id,
        d.name AS driver_name,
        d.employee_id,
        d.vehicle,
        t.start_time,
        t.end_time,
        ROUND(t.duration_seconds / 60, 1) AS duration_minutes,
        t.warning_count,
        t.danger_count,
        t.microsleep_count,
        t.yawn_count,
        t.avg_perclos,
        t.risk_score,
        t.risk_level
      FROM trips t
      JOIN drivers d ON d.id = t.driver_id
    `;
    const params = [];
    let targetDriver = null;

    if (query.driver_id) {
      targetDriver = db.prepare('SELECT id, name, employee_id FROM drivers WHERE id = ? OR employee_id = ?').get(query.driver_id, query.driver_id);
      if (targetDriver) {
        sql += ` WHERE t.driver_id = ? `;
        params.push(targetDriver.id);
      } else {
        sql += ` WHERE t.driver_id = ? `;
        params.push(query.driver_id);
      }
    }

    sql += ` ORDER BY t.start_time DESC LIMIT 1000 `;
    const rows = db.prepare(sql).all(...params);

    if (query.format === 'csv') {
      const headers = ['Trip ID', 'Driver Name', 'Employee ID', 'Vehicle', 'Start Time', 'End Time', 'Duration (min)', 'Warnings', 'Dangers', 'Microsleeps', 'Yawns', 'Avg PERCLOS', 'Risk Score', 'Risk Level'];
      let csv = headers.join(',') + '\n';
      for (const r of rows) {
        csv += [
          r.trip_id,
          `"${(r.driver_name || '').replace(/"/g, '""')}"`,
          r.employee_id,
          `"${(r.vehicle || '').replace(/"/g, '""')}"`,
          r.start_time,
          r.end_time || 'In Progress',
          r.duration_minutes,
          r.warning_count,
          r.danger_count,
          r.microsleep_count,
          r.yawn_count,
          r.avg_perclos,
          r.risk_score,
          r.risk_level,
        ].join(',') + '\n';
      }

      const filename = targetDriver 
        ? `drowsyguard-report-${targetDriver.employee_id}.csv` 
        : 'drowsyguard-fleet-report.csv';

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end(csv);
      return;
    }

    return sendJson(res, 200, { reports: rows, driver: targetDriver });
  }

  // ── Settings Routes ─────────────────────────────────────────────────────
  if (pathname === '/api/settings') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    // Supervisors CANNOT view or edit settings
    if (auth.role === 'supervisor') {
      return sendError(res, 403, 'Supervisors do not have access to System Settings');
    }

    if (method === 'GET') {
      const rows = db.prepare('SELECT key, value FROM system_settings').all();
      const settings = {};
      for (const r of rows) settings[r.key] = r.value;
      return sendJson(res, 200, { settings, esp32StreamUrl });
    }

    if (method === 'PATCH') {
      if (auth.role !== 'admin') return sendError(res, 403, 'Admin role required');
      const body = await readJsonBody(req);
      const updateSetting = db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');

      db.transaction(() => {
        for (const [k, v] of Object.entries(body)) {
          updateSetting.run(k, String(v));
          if (k === 'esp32StreamUrl') {
            esp32StreamUrl = String(v).trim();
            // Update config.json as well
            try {
              fs.writeFileSync(CONFIG_PATH, JSON.stringify({ esp32Stream: esp32StreamUrl }, null, 2));
            } catch (_) {}
          }
        }
      })();

      return sendJson(res, 200, { message: 'Settings saved', settings: body });
    }
    return;
  }
  // ── Camera Control Routes ───────────────────────────────────────────────
  if (pathname === '/api/camera/tune' && method === 'POST') {
    const parsed = url.parse(esp32StreamUrl);
    const host = parsed.hostname || '10.15.80.91';
    autoTuneEsp32Camera(host, true);
    return sendJson(res, 200, { success: true, message: 'Camera auto-tuned' });
  }

  if (pathname === '/api/camera/control' && method === 'POST') {
    const body = await readJsonBody(req);
    const { var: varName, val } = body;
    if (varName === undefined || val === undefined) {
      return sendError(res, 400, 'var and val required');
    }
    const parsed = url.parse(esp32StreamUrl);
    const host = parsed.hostname || '10.15.80.91';
    try {
      const espReq = http.get(`http://${host}/control?var=${varName}&val=${val}`, (espRes) => {
        sendJson(res, 200, { success: true, var: varName, val });
      });
      espReq.on('error', (err) => {
        sendError(res, 502, 'ESP32 control failed: ' + err.message);
      });
    } catch (e) {
      sendError(res, 500, e.message);
    }
    return;
  }

  if (pathname === '/api/camera/status' && method === 'GET') {
    const parsed = url.parse(esp32StreamUrl);
    const host = parsed.hostname || '10.15.80.91';
    http.get(`http://${host}/status`, (espRes) => {
      let data = '';
      espRes.on('data', c => data += c);
      espRes.on('end', () => {
        try {
          sendJson(res, 200, JSON.parse(data));
        } catch (_) {
          sendError(res, 502, 'Invalid JSON from ESP32');
        }
      });
    }).on('error', err => sendError(res, 502, 'ESP32 unreachable: ' + err.message));
    return;
  }

  // ── Snapshot Incident Routes ─────────────────────────────────────────────
  if (pathname === '/api/snapshots/upload' && method === 'POST') {
    try {
      const { fields, files } = await parseMultipartBody(req);
      const snapshotFile = files.snapshot || files.file;
      if (!snapshotFile || !snapshotFile.data || snapshotFile.data.length === 0) {
        return sendError(res, 400, 'Missing snapshot file in upload');
      }

      const driverId = (fields.driver_id || 'EMP001').trim();
      const triggerType = (fields.trigger || fields.trigger_type || 'microsleep').trim();

      const snapshotsDir = path.join(DATA_DIR, 'snapshots', driverId);
      if (!fs.existsSync(snapshotsDir)) {
        fs.mkdirSync(snapshotsDir, { recursive: true });
      }

      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `${dateStr}.jpg`;
      const filepath = path.join(snapshotsDir, filename);

      fs.writeFileSync(filepath, snapshotFile.data);

      // Check if driver has an active trip
      let tripId = null;
      try {
        const activeTrip = db.prepare(`
          SELECT t.id FROM trips t
          JOIN drivers d ON d.id = t.driver_id
          WHERE (d.employee_id = ? OR d.id = ?) AND t.status = 'active'
          ORDER BY t.start_time DESC LIMIT 1
        `).get(driverId, driverId);
        if (activeTrip) tripId = activeTrip.id;
      } catch (_) {}

      const stmt = db.prepare(`
        INSERT INTO snapshots (driver_id, trip_id, filename, filepath, trigger_type, captured_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `);
      const info = stmt.run(driverId, tripId, filename, filepath, triggerType);

      return sendJson(res, 201, {
        id: info.lastInsertRowid,
        saved: true,
        filename,
        trigger_type: triggerType
      });
    } catch (err) {
      console.error('[snapshot-upload-error]', err);
      return sendError(res, 500, 'Snapshot upload failed: ' + err.message);
    }
  }

  if (pathname === '/api/snapshots/trigger' && method === 'POST') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    let body = {};
    try { body = await readJsonBody(req); } catch (_) {}
    const triggerType = (body && body.trigger) ? body.trigger : 'microsleep';

    const parsed = url.parse(esp32StreamUrl);
    const host = parsed.hostname || '10.15.80.91';

    let responded = false;
    const triggerReq = http.get({
      host,
      port: 80,
      path: `/trigger-snapshot?trigger=${encodeURIComponent(triggerType)}`,
      timeout: 5000,
    }, (espRes) => {
      let data = '';
      espRes.on('data', c => data += c);
      espRes.on('end', () => {
        if (responded) return;
        responded = true;
        try {
          return sendJson(res, 200, JSON.parse(data));
        } catch (_) {
          return sendJson(res, 200, { success: true, raw: data });
        }
      });
    });

    triggerReq.on('error', (err) => {
      if (responded) return;
      responded = true;
      return sendJson(res, 502, {
        success: false,
        error: 'ESP32 camera unreachable',
        details: err.message
      });
    });

    triggerReq.on('timeout', () => {
      if (responded) return;
      responded = true;
      triggerReq.destroy();
      return sendJson(res, 504, {
        success: false,
        error: 'ESP32 snapshot request timed out'
      });
    });
    return;
  }

  const snapImageMatch = pathname.match(/^\/api\/snapshots\/image\/(\d+)$/);
  if (snapImageMatch && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const snapId = parseInt(snapImageMatch[1], 10);
    const snap = db.prepare('SELECT filepath, filename FROM snapshots WHERE id = ?').get(snapId);
    if (!snap || !fs.existsSync(snap.filepath)) {
      return sendError(res, 404, 'Snapshot image not found');
    }

    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `inline; filename="${snap.filename}"`
    });
    const stream = fs.createReadStream(snap.filepath);
    return stream.pipe(res);
  }

  const snapDriverMatch = pathname.match(/^\/api\/snapshots\/([^/]+)$/);
  if (snapDriverMatch && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');

    const driverParam = snapDriverMatch[1];
    if (driverParam !== 'upload' && driverParam !== 'trigger' && driverParam !== 'image') {
      const rows = db.prepare(`
        SELECT id, driver_id, trip_id, filename, trigger_type, captured_at, uploaded_at
        FROM snapshots
        WHERE driver_id = ? OR driver_id IN (SELECT employee_id FROM drivers WHERE id = ?)
        ORDER BY captured_at DESC
      `).all(driverParam, driverParam);

      return sendJson(res, 200, { snapshots: rows });
    }
  }

  // ── User Management Route Guard ─────────────────────────────────────────
  if (pathname.startsWith('/api/users')) {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    if (auth.role !== 'admin') {
      return sendError(res, 403, 'Admin role required for user management');
    }
  }

  // Fallthrough: unhandled API endpoint
  sendError(res, 404, `Endpoint not found: ${method} ${pathname}`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] Port ${PORT} is already in use.`);
    console.error(`[server] A server process is already running. To stop or restart it:\n`);
    console.error(`  PowerShell: $p = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force }\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`
┌────────────────────────────────────────────────────────┐
│  🛡️   Driver-Fatigue Detection — Fleet Safety Server   │
├────────────────────────────────────────────────────────┤
│  App Port      →  http://localhost:${PORT}                 │
│  Admin Portal  →  http://localhost:${PORT}/admin           │
│  Driver Kiosk  →  http://localhost:${PORT}/driver          │
│  WebSocket     →  ws://localhost:${PORT}/ws                │
│  ESP32 Proxy   →  http://localhost:${PORT}/esp32/stream    │
│  Camera Target →  ${esp32StreamUrl}
└────────────────────────────────────────────────────────┘
  Database: ${DB_PATH}
`);
});

module.exports = { server, db, wss };
