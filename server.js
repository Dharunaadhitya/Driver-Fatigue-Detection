/**
 * Driver-Fatigue Detection — Backend Server & Reverse Proxy
 *
 * Capabilities:
 * - SQLite Database via better-sqlite3 with WAL mode and schema auto-creation
 * - REST API: Authentication (JWT), Drivers, Trips, Telemetry Events, Stats, Reports (CSV), Settings
 * - WebSocket server on /ws for real-time telemetry, driver status & microsleep broadcasts
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
let DATA_DIR = path.join(__dirname, 'data');
let DB_PATH = path.join(DATA_DIR, 'drowsyguard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const JWT_SECRET = process.env.JWT_SECRET || 'drowsyguard-fleet-secure-secret-2026';

// ── Vercel Serverless /tmp adaptation ─────────────────────────────────────
if (process.env.VERCEL) {
  const tmpDir = path.join('/tmp', 'data');
  if (!fs.existsSync(tmpDir)) {
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  }
  const tmpDb = path.join(tmpDir, 'drowsyguard.db');
  if (!fs.existsSync(tmpDb) && fs.existsSync(DB_PATH)) {
    try { fs.copyFileSync(DB_PATH, tmpDb); } catch (_) {}
  }
  DATA_DIR = tmpDir;
  if (fs.existsSync(tmpDb)) {
    DB_PATH = tmpDb;
  }
}

// ── Database Initialization ───────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema if tables do not exist
try {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

  // Auto-seed if database is brand new (e.g., on Render or fresh deployment)
  const userCheck = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (!userCheck || userCheck.count === 0) {
    console.log('[db] Fresh deployment detected — running auto-seed to create admin & driver credentials...');
    try {
      const { execSync } = require('child_process');
      execSync('node seed.js', { stdio: 'inherit', cwd: ROOT });
    } catch (sErr) {
      console.error('[db] Error executing seed.js:', sErr.message);
    }
  }
} catch (err) {
  console.error('[db] Error initializing database:', err.message);
}

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
    filePath = path.join(ROOT, 'index.html');
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
      return sendJson(res, 200, { settings });
    }

    if (method === 'PATCH') {
      if (auth.role !== 'admin') return sendError(res, 403, 'Admin role required');
      const body = await readJsonBody(req);
      const updateSetting = db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');

      db.transaction(() => {
        for (const [k, v] of Object.entries(body)) {
          updateSetting.run(k, String(v));
        }
      })();

      return sendJson(res, 200, { message: 'Settings saved', settings: body });
    }
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
    return sendJson(res, 200, { success: true, message: 'Snapshot trigger acknowledged' });
  }

  function generateSnapshotSvg(snap) {
    const driverId = snap.driver_id || 'DRV-101';
    const trigger = (snap.trigger_type || 'microsleep').toUpperCase();
    const time = snap.captured_at ? new Date(snap.captured_at).toISOString().replace('T', ' ').substring(0, 19) : 'INCIDENT RECORD';
    const color = trigger === 'MICROSLEEP' ? '#EF4444' : (trigger === 'DANGER' ? '#F97316' : '#F59E0B');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480">
  <defs>
    <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#090d16"/>
    </radialGradient>
  </defs>
  <rect width="640" height="480" fill="url(#vignette)"/>
  <line x1="40" y1="240" x2="600" y2="240" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
  <line x1="320" y1="40" x2="320" y2="440" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
  <circle cx="320" cy="210" r="105" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.35"/>
  <ellipse cx="320" cy="370" rx="140" ry="80" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <path d="M 270 190 Q 285 185 300 190 Q 285 195 270 190 Z" fill="${color}" fill-opacity="0.7" stroke="${color}"/>
  <path d="M 340 190 Q 355 185 370 190 Q 355 195 340 190 Z" fill="${color}" fill-opacity="0.7" stroke="${color}"/>
  <path d="M 320 200 L 315 225 L 325 225" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="320" cy="260" rx="${trigger === 'YAWN' ? '22' : '16'}" ry="${trigger === 'YAWN' ? '18' : '6'}" fill="rgba(0,0,0,0.5)" stroke="${color}" stroke-width="2"/>
  <rect x="24" y="24" width="140" height="30" rx="6" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1.5"/>
  <text x="94" y="44" fill="${color}" font-family="system-ui, sans-serif" font-weight="700" font-size="13" text-anchor="middle">⚠️ ${trigger}</text>
  <rect x="500" y="24" width="116" height="30" rx="6" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.2)"/>
  <text x="558" y="44" fill="#38BDF8" font-family="monospace" font-weight="600" font-size="12" text-anchor="middle">REC ● LIVE</text>
  <rect x="0" y="430" width="640" height="50" fill="rgba(0,0,0,0.75)"/>
  <text x="24" y="462" fill="#E2E8F0" font-family="monospace" font-size="13" font-weight="600">DRIVER: ${driverId}</text>
  <text x="320" y="462" fill="#94A3B8" font-family="monospace" font-size="12" text-anchor="middle">${time}</text>
  <text x="616" y="462" fill="${color}" font-family="monospace" font-size="13" font-weight="700" text-anchor="end">INCIDENT #${snap.id || '01'}</text>
</svg>`;
  }

  const snapImageMatch = pathname.match(/^\/api\/snapshots\/image\/(\d+)$/);
  if (snapImageMatch && method === 'GET') {
    const snapId = parseInt(snapImageMatch[1], 10);
    const snap = db.prepare('SELECT id, filepath, filename, driver_id, trigger_type, captured_at FROM snapshots WHERE id = ?').get(snapId);
    if (!snap) {
      return sendError(res, 404, 'Snapshot record not found');
    }

    // Direct SVG fallback requested
    if (query.fallback === 'svg') {
      const svgData = generateSnapshotSvg(snap);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `inline; filename="snapshot_${snap.id}.svg"`
      });
      return res.end(svgData);
    }

    let filePath = snap.filepath;
    let fileValid = false;

    // Check primary and alternate paths
    const candidates = [
      filePath,
      path.join(DATA_DIR, 'snapshots', String(snap.driver_id || ''), snap.filename || ''),
      path.join(DATA_DIR, 'snapshots', snap.filename || '')
    ];

    for (const cand of candidates) {
      if (cand && fs.existsSync(cand)) {
        try {
          const st = fs.statSync(cand);
          if (st.isFile() && st.size > 100) {
            filePath = cand;
            fileValid = true;
            break;
          }
        } catch (_) {}
      }
    }

    if (!fileValid) {
      // Safe dynamic SVG fallback if file is missing, corrupt, or stub (<100 bytes)
      const svgData = generateSnapshotSvg(snap);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `inline; filename="snapshot_${snap.id}.svg"`
      });
      return res.end(svgData);
    }

    // Sniff actual content type from file header
    let contentType = 'image/jpeg';
    try {
      const headBuf = Buffer.alloc(64);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, headBuf, 0, 64, 0);
      fs.closeSync(fd);

      const headStr = headBuf.toString('utf8');
      if (headStr.includes('<svg') || headStr.includes('<?xml')) {
        contentType = 'image/svg+xml; charset=utf-8';
      } else if (headBuf[0] === 0x89 && headBuf[1] === 0x50 && headBuf[2] === 0x4E && headBuf[3] === 0x47) {
        contentType = 'image/png';
      } else if (headBuf[0] === 0xFF && headBuf[1] === 0xD8) {
        contentType = 'image/jpeg';
      }
    } catch (_) {}

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': `inline; filename="${snap.filename || 'snapshot.jpg'}"`
    });
    const stream = fs.createReadStream(filePath);
    return stream.pipe(res);
  }

  const snapDriverMatch = pathname.match(/^\/api\/snapshots\/([^/]+)$/);
  if (snapDriverMatch && method === 'GET') {
    const driverParam = snapDriverMatch[1];
    if (driverParam !== 'upload' && driverParam !== 'trigger' && driverParam !== 'image') {
      let rows;
      if (driverParam === 'all') {
        rows = db.prepare(`
          SELECT id, driver_id, trip_id, filename, trigger_type, captured_at, uploaded_at
          FROM snapshots
          ORDER BY captured_at DESC
        `).all();
      } else {
        rows = db.prepare(`
          SELECT id, driver_id, trip_id, filename, trigger_type, captured_at, uploaded_at
          FROM snapshots
          WHERE driver_id = ? 
             OR driver_id IN (SELECT employee_id FROM drivers WHERE id = ?) 
             OR driver_id IN (SELECT CAST(id AS TEXT) FROM drivers WHERE employee_id = ?)
          ORDER BY captured_at DESC
        `).all(driverParam, driverParam, driverParam);
      }

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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`
┌────────────────────────────────────────────────────────┐
│  🛡️   Driver-Fatigue Detection — Fleet Safety Server   │
├────────────────────────────────────────────────────────┤
│  App Port      →  http://localhost:${PORT}                 │
│  Admin Portal  →  http://localhost:${PORT}/admin           │
│  Driver Kiosk  →  http://localhost:${PORT}/driver          │
│  WebSocket     →  ws://localhost:${PORT}/ws                │
└────────────────────────────────────────────────────────┘
  Database: ${DB_PATH}
`);
  });
}

module.exports = server;
module.exports.server = server;
module.exports.db = db;
module.exports.wss = wss;
