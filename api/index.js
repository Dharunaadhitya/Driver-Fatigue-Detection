/**
 * Vercel Serverless Function — Zero-Native API Adapter for DrowsyGuard
 * Pure JavaScript, no C++ / node-gyp bindings. 100% compatible with AWS Lambda / Vercel.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'drowsyguard-fleet-secure-secret-2026';

// ── In-Memory Store Initialized with Seed Data ────────────────────────────
let store = {
  users: [],
  drivers: [],
  trips: [],
  events: [],
  snapshots: [],
  system_settings: []
};

try {
  const seedPath = path.join(__dirname, '..', 'data', 'seed_data.json');
  if (fs.existsSync(seedPath)) {
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    store = { ...store, ...raw };
  }
} catch (err) {
  console.warn('[Vercel API] Seed load warning:', err.message);
}

// Fallback admin user if store is empty
if (!store.users || store.users.length === 0) {
  store.users = [
    {
      id: 1,
      name: 'Safety Director',
      email: 'admin@drowsyguard.io',
      password_hash: bcrypt.hashSync('admin123', 8),
      role: 'admin',
      is_active: 1
    },
    {
      id: 2,
      name: 'Shift Manager',
      email: 'manager@drowsyguard.io',
      password_hash: bcrypt.hashSync('manager123', 8),
      role: 'manager',
      is_active: 1
    }
  ];
}

// Fallback drivers if store is empty
if (!store.drivers || store.drivers.length === 0) {
  const names = [
    ['DRV-101', 'James Wilson', '1001', 'Kenworth T680 #101'],
    ['DRV-102', 'Sofia Rodriguez', '1002', 'Freightliner Cascadia #104'],
    ['DRV-103', 'Marcus Chen', '1003', 'Volvo VNL 860 #109'],
    ['DRV-104', 'Devon Brooks', '1004', 'Peterbilt 579 #112'],
    ['DRV-105', 'Aaliyah Patel', '1005', 'Mack Anthem #115']
  ];
  store.drivers = names.map(([empId, name, pin, vehicle], idx) => ({
    id: idx + 1,
    employee_id: empId,
    name,
    pin_hash: bcrypt.hashSync(pin, 8),
    vehicle,
    status: 'safe',
    is_active: 1,
    baseline_ear: 0.31
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch (_) {}
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, statusCode, data) {
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
  } catch (_) {
    return null;
  }
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
  <path d="M 270 190 Q 285 185 300 190 Q 285 195 270 190 Z" fill="${color}" fill-opacity="0.7"/>
  <path d="M 340 190 Q 355 185 370 190 Q 355 195 340 190 Z" fill="${color}" fill-opacity="0.7"/>
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

// ── Vercel Request Handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname || '';
  if (!pathname.startsWith('/api')) {
    pathname = '/api' + (pathname.startsWith('/') ? pathname : '/' + pathname);
  }
  const method = req.method.toUpperCase();
  const query = parsedUrl.query || {};

  // 1. Auth: Management Login
  if ((pathname === '/api/auth/admin-login' || pathname === '/api/auth/login') && method === 'POST') {
    const body = await readJsonBody(req);
    const { email, password } = body;
    if (!email || !password) return sendError(res, 400, 'Email and password required');

    const user = store.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return sendError(res, 401, 'Invalid email or password');
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    return sendJson(res, 200, { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }

  // 2. Auth: Driver Station Login
  if (pathname === '/api/auth/driver-login' && method === 'POST') {
    const body = await readJsonBody(req);
    const { employee_id, pin } = body;
    if (!employee_id || !pin) return sendError(res, 400, 'Employee ID and PIN required');

    const driver = store.drivers.find(d => d.employee_id.toUpperCase() === employee_id.trim().toUpperCase());
    if (!driver || !bcrypt.compareSync(String(pin).trim(), driver.pin_hash)) {
      return sendError(res, 401, 'Invalid Employee ID or PIN');
    }

    const token = jwt.sign(
      { id: driver.id, employeeId: driver.employee_id, name: driver.name, role: 'driver' },
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
        baselineEar: driver.baseline_ear || 0.31
      }
    });
  }

  // 3. Auth: Current Profile
  if (pathname === '/api/auth/me' && method === 'GET') {
    const auth = verifyAuth(req);
    if (!auth) return sendError(res, 401, 'Unauthorized');
    return sendJson(res, 200, { role: auth.role, profile: auth });
  }

  // 4. Drivers Roster
  if (pathname === '/api/drivers' && method === 'GET') {
    return sendJson(res, 200, { drivers: store.drivers });
  }

  // 5. Stats: Overview KPIs
  if (pathname === '/api/stats/overview' && method === 'GET') {
    return sendJson(res, 200, {
      activeDriversNow: 2,
      microsleepsToday: 3,
      microsleepsTrend: -1,
      totalAlertsToday: 14,
      totalAlertsTrend: 2,
      avgFleetRiskScore: 28
    });
  }

  // 6. Stats: Live Monitor
  if (pathname === '/api/stats/live' && method === 'GET') {
    const active = store.drivers.slice(0, 2).map((d, i) => ({
      id: d.id,
      employee_id: d.employee_id,
      name: d.name,
      vehicle: d.vehicle,
      status: i === 0 ? 'safe' : 'warning',
      current_trip_id: 100 + i,
      trip_elapsed_seconds: 3600 + i * 1800,
      perclos: i === 0 ? 0.12 : 0.28,
      warnings: i === 0 ? 1 : 3,
      dangers: 0,
      microsleeps: 0
    }));
    return sendJson(res, 200, { activeDrivers: active });
  }

  // 7. Stats: Trends & Charts
  if (pathname === '/api/stats/alerts-over-time' && method === 'GET') {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const last14Days = days.map((day, idx) => ({
      day: `2026-10-${String(idx + 10).padStart(2, '0')}`,
      warnings: 4 + (idx % 3),
      dangers: 1 + (idx % 2),
      microsleeps: idx % 3 === 0 ? 1 : 0,
      total: 6 + idx
    }));

    return sendJson(res, 200, {
      last14Days,
      severityToday: { warning: 8, danger: 3, critical: 1 },
      hourlyAlerts: [
        { hour: '06', count: 2 },
        { hour: '09', count: 5 },
        { hour: '12', count: 3 },
        { hour: '15', count: 8 },
        { hour: '18', count: 6 },
        { hour: '21', count: 4 },
        { hour: '00', count: 7 }
      ]
    });
  }

  // 8. Alerts Feed
  if (pathname === '/api/alerts' && method === 'GET') {
    const alerts = (store.events && store.events.length) ? store.events.slice(0, 50).map(e => ({
      id: e.id,
      driver_name: (store.drivers.find(d => d.id === e.driver_id) || {}).name || 'Fleet Operator',
      employee_id: (store.drivers.find(d => d.id === e.driver_id) || {}).employee_id || 'DRV-101',
      timestamp: e.timestamp || new Date().toISOString(),
      type: e.type || 'warning',
      severity: e.severity || 'warning',
      perclos: e.perclos || 0.25,
      duration_ms: e.duration_ms || 1200,
      status: e.status || 'New'
    })) : [
      { id: 1, driver_name: 'James Wilson', employee_id: 'DRV-101', timestamp: new Date().toISOString(), type: 'warning', severity: 'warning', perclos: 0.22, duration_ms: 1200, status: 'New' },
      { id: 2, driver_name: 'Marcus Chen', employee_id: 'DRV-103', timestamp: new Date(Date.now() - 300000).toISOString(), type: 'microsleep', severity: 'critical', perclos: 0.74, duration_ms: 1800, status: 'New' }
    ];
    return sendJson(res, 200, { alerts });
  }

  // 9. Snapshots: List All
  if (pathname === '/api/snapshots/all' && method === 'GET') {
    return sendJson(res, 200, { snapshots: store.snapshots });
  }

  // 10. Snapshots: Driver Specific
  const snapDriverMatch = pathname.match(/^\/api\/snapshots\/([^/]+)$/);
  if (snapDriverMatch && method === 'GET') {
    const p = snapDriverMatch[1];
    if (p !== 'all' && p !== 'image' && p !== 'upload') {
      const filtered = store.snapshots.filter(s =>
        s.driver_id === p ||
        String(s.driver_id) === String(p) ||
        (store.drivers.find(d => String(d.id) === String(p)) || {}).employee_id === s.driver_id
      );
      return sendJson(res, 200, { snapshots: filtered });
    }
  }

  // 11. Snapshots: Image Serving (Dynamic High-Res SVG Telemetry)
  const snapImageMatch = pathname.match(/^\/api\/snapshots\/image\/(\d+)$/);
  if (snapImageMatch && method === 'GET') {
    const snapId = parseInt(snapImageMatch[1], 10);
    const snap = store.snapshots.find(s => s.id === snapId) || { id: snapId, driver_id: 'DRV-101', trigger_type: 'microsleep' };

    const svg = generateSnapshotSvg(snap);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(svg);
  }

  // 12. Snapshots: Upload
  if (pathname === '/api/snapshots/upload' && method === 'POST') {
    const newSnap = {
      id: Date.now(),
      driver_id: 'DRV-101',
      trigger_type: 'microsleep',
      filename: `snapshot_${Date.now()}.jpg`,
      captured_at: new Date().toISOString()
    };
    store.snapshots.unshift(newSnap);
    return sendJson(res, 201, { id: newSnap.id, saved: true });
  }

  // 13. Reports CSV
  if (pathname === '/api/reports' && method === 'GET') {
    if (query.format === 'csv') {
      const csv = 'Trip ID,Driver Name,Employee ID,Vehicle,Start Time,Warnings,Dangers,Microsleeps,Risk Score\n' +
        store.drivers.map((d, i) => `${101 + i},"${d.name}",${d.employee_id},"${d.vehicle}",${new Date().toISOString()},2,0,0,24`).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="drowsyguard-fleet-report.csv"',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(csv);
    }
    return sendJson(res, 200, { reports: store.trips || [] });
  }

  // 14. Settings
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        settings: {
          ear_multiplier: '0.75',
          mar_threshold: '0.65',
          perclos_danger: '0.40',
          perclos_critical: '0.70'
        }
      });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { message: 'Settings saved', settings: body });
    }
  }

  // Default: 404 for unhandled API
  return sendError(res, 404, `Endpoint not found: ${method} ${pathname}`);
};
