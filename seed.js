/**
 * DrowsyGuard Fleet — Database Seed Script
 * Generates company, admin & manager accounts, 10 fleet drivers, and 60 days of realistic trips and telemetry events.
 *
 * Usage: node seed.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { computeRiskScore } = require('./riskScore');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'drowsyguard.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Open / create DB with WAL mode
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
console.log('🌱 Seeding DrowsyGuard Fleet database...');

// Drop tables to apply updated constraints cleanly
const tables = ['snapshots', 'events', 'trips', 'calibration_profiles', 'drivers', 'users', 'companies', 'system_settings'];
for (const table of tables) {
  db.exec(`DROP TABLE IF EXISTS ${table};`);
}

// Run schema
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

// 1. Company
const insertCompany = db.prepare('INSERT INTO companies (name) VALUES (?)');
const companyRes = insertCompany.run('Apex Global Logistics');
const companyId = companyRes.lastInsertRowid;

// 2. Admin, Manager & Supervisor Users
const insertUser = db.prepare(`
  INSERT INTO users (company_id, name, email, password_hash, role)
  VALUES (?, ?, ?, ?, ?)
`);

const adminHash = bcrypt.hashSync('admin123', 8);
const managerHash = bcrypt.hashSync('manager123', 8);
const supervisorHash = bcrypt.hashSync('supervisor123', 8);

const adminUser = insertUser.run(companyId, 'Marcus Vance (Director)', 'admin@drowsyguard.io', adminHash, 'admin');
const managerUser = insertUser.run(companyId, 'Elena Rostova (Fleet Ops)', 'manager@drowsyguard.io', managerHash, 'manager');
const supervisorUser = insertUser.run(companyId, 'Carlos Mendez (Shift Supervisor)', 'supervisor@drowsyguard.io', supervisorHash, 'supervisor');

// 3. 10 Fleet Drivers
const insertDriver = db.prepare(`
  INSERT INTO drivers (company_id, employee_id, name, pin_hash, vehicle, status, is_active)
  VALUES (?, ?, ?, ?, ?, ?, 1)
`);

const insertCalibration = db.prepare(`
  INSERT INTO calibration_profiles (driver_id, baseline_ear)
  VALUES (?, ?)
`);

const rawDrivers = [
  { empId: 'DRV-101', name: 'James Wilson',    pin: '1001', vehicle: 'Kenworth T680 #101', baselineEar: 0.31, riskTier: 'low' },
  { empId: 'DRV-102', name: 'Sofia Rodriguez', pin: '1002', vehicle: 'Freightliner Cascadia #104', baselineEar: 0.29, riskTier: 'low' },
  { empId: 'DRV-103', name: 'Marcus Chen',     pin: '1003', vehicle: 'Volvo VNL 860 #109', baselineEar: 0.33, riskTier: 'moderate' },
  { empId: 'DRV-104', name: 'Devon Brooks',    pin: '1004', vehicle: 'Peterbilt 579 #112', baselineEar: 0.28, riskTier: 'high' },
  { empId: 'DRV-105', name: 'Aaliyah Patel',   pin: '1005', vehicle: 'Mack Anthem #115', baselineEar: 0.30, riskTier: 'low' },
  { empId: 'DRV-106', name: 'Tyler Kowalski',  pin: '1006', vehicle: 'International LT #118', baselineEar: 0.32, riskTier: 'critical' },
  { empId: 'DRV-107', name: 'Chloe Dubois',    pin: '1007', vehicle: 'Kenworth T680 #121', baselineEar: 0.29, riskTier: 'moderate' },
  { empId: 'DRV-108', name: 'Ramon Gutierrez', pin: '1008', vehicle: 'Freightliner Cascadia #125', baselineEar: 0.31, riskTier: 'low' },
  { empId: 'DRV-109', name: 'Zackariah King',  pin: '1009', vehicle: 'Volvo VNL 760 #128', baselineEar: 0.30, riskTier: 'high' },
  { empId: 'DRV-110', name: 'Nadia Brennan',   pin: '1010', vehicle: 'Peterbilt 579 #132', baselineEar: 0.32, riskTier: 'low' },
];

const createdDrivers = [];
for (const d of rawDrivers) {
  const pinHash = bcrypt.hashSync(d.pin, 8);
  const res = insertDriver.run(companyId, d.empId, d.name, pinHash, d.vehicle, 'offline');
  const driverId = res.lastInsertRowid;
  insertCalibration.run(driverId, d.baselineEar);
  createdDrivers.push({ id: driverId, ...d });
}

// 4. System Settings
const insertSetting = db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)');
insertSetting.run('earMultiplier', '0.75');
insertSetting.run('marThreshold', '0.60');
insertSetting.run('perclosWarningPct', '40');
insertSetting.run('perclosDangerPct', '70');
insertSetting.run('microsleepFrames', '45');

// 5. 60 Days of Trips and Events
const insertTrip = db.prepare(`
  INSERT INTO trips (driver_id, start_time, end_time, status, duration_seconds, warning_count, danger_count, microsleep_count, yawn_count, avg_perclos, risk_score, risk_level)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (trip_id, driver_id, timestamp, type, severity, duration_ms, ear, mar, perclos, status, notes, acknowledged_by, acknowledged_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = new Date();
const SECONDS_PER_DAY = 86400;

console.log('Generating 60 days of historical telemetry...');

db.transaction(() => {
  for (let dayOffset = 59; dayOffset >= 0; dayOffset--) {
    const tripDate = new Date(now.getTime() - dayOffset * SECONDS_PER_DAY * 1000);

    for (const driver of createdDrivers) {
      // 70% chance driver worked on any given day
      const workedToday = ((driver.id + dayOffset * 3) % 10) < 7;
      if (!workedToday) continue;

      const startHour = 6 + ((driver.id * 2 + dayOffset) % 8);
      const tripStart = new Date(tripDate);
      tripStart.setHours(startHour, 15, 0, 0);

      // Duration: 2 to 7 hours
      let durationHours = 3.5 + ((driver.id + dayOffset) % 4);
      if (driver.riskTier === 'high' || driver.riskTier === 'critical') {
        durationHours += 1.5;
      }
      const durationSeconds = Math.round(durationHours * 3600);
      const tripEnd = new Date(tripStart.getTime() + durationSeconds * 1000);

      // Generate incidents based on driver risk tier
      let warnings = 0;
      let dangers = 0;
      let microsleeps = 0;
      let yawns = Math.floor(Math.random() * 3);
      let avgPerclos = 0.08 + Math.random() * 0.06;

      if (driver.riskTier === 'moderate') {
        warnings = 1 + Math.floor(Math.random() * 3);
        yawns = 2 + Math.floor(Math.random() * 4);
        avgPerclos = 0.16 + Math.random() * 0.10;
        if (dayOffset % 7 === 0) dangers = 1;
      } else if (driver.riskTier === 'high') {
        warnings = 3 + Math.floor(Math.random() * 4);
        dangers = 1 + Math.floor(Math.random() * 3);
        yawns = 4 + Math.floor(Math.random() * 5);
        avgPerclos = 0.26 + Math.random() * 0.15;
        if (dayOffset % 12 === 0) microsleeps = 1;
      } else if (driver.riskTier === 'critical') {
        warnings = 4 + Math.floor(Math.random() * 5);
        dangers = 2 + Math.floor(Math.random() * 3);
        yawns = 5 + Math.floor(Math.random() * 6);
        avgPerclos = 0.35 + Math.random() * 0.18;
        if (dayOffset % 5 === 0) microsleeps = 1 + Math.floor(Math.random() * 2);
      }

      const { score, level } = computeRiskScore({
        microsleepCount: microsleeps,
        dangerCount: dangers,
        warningCount: warnings,
        yawnCount: yawns,
        avgPerclos,
        durationSeconds,
      });

      const tripRes = insertTrip.run(
        driver.id,
        tripStart.toISOString(),
        tripEnd.toISOString(),
        'completed',
        durationSeconds,
        warnings,
        dangers,
        microsleeps,
        yawns,
        parseFloat(avgPerclos.toFixed(3)),
        score,
        level
      );
      const tripId = tripRes.lastInsertRowid;

      // Seed explicit events for incidents
      const eventCount = warnings + dangers + microsleeps;
      for (let i = 0; i < eventCount; i++) {
        const offsetSec = Math.floor(Math.random() * (durationSeconds - 300)) + 120;
        const evTime = new Date(tripStart.getTime() + offsetSec * 1000).toISOString();

        let type = 'warning';
        let severity = 'warning';
        let durationMs = 1200;
        let ear = driver.baselineEar * 0.72;
        let mar = 0.45;
        let perclos = 0.42;

        if (i < microsleeps) {
          type = 'microsleep';
          severity = 'critical';
          durationMs = 2100;
          ear = 0.14;
          perclos = 0.88;
        } else if (i < microsleeps + dangers) {
          type = 'danger';
          severity = 'danger';
          durationMs = 1500;
          ear = 0.18;
          perclos = 0.74;
        } else {
          type = i % 2 === 0 ? 'yawn' : 'warning';
          mar = type === 'yawn' ? 0.72 : 0.45;
        }

        const isAck = dayOffset > 1; // older events acknowledged
        insertEvent.run(
          tripId,
          driver.id,
          evTime,
          type,
          severity,
          durationMs,
          parseFloat(ear.toFixed(3)),
          parseFloat(mar.toFixed(3)),
          parseFloat(perclos.toFixed(3)),
          isAck ? 'Acknowledged' : 'New',
          isAck ? 'Driver contacted and advised mandatory 20min rest.' : null,
          isAck ? adminUser.lastInsertRowid : null,
          isAck ? evTime : null
        );
      }
    }
  }

  // Set 2 drivers currently active on shift today
  const activeDriver1 = createdDrivers[0]; // James Wilson
  const activeDriver2 = createdDrivers[2]; // Marcus Chen

  const activeTripStart1 = new Date(now.getTime() - 75 * 60 * 1000).toISOString(); // 1h 15m ago
  const activeTripStart2 = new Date(now.getTime() - 210 * 60 * 1000).toISOString(); // 3h 30m ago

  const t1 = insertTrip.run(activeDriver1.id, activeTripStart1, null, 'active', 4500, 1, 0, 0, 1, 0.12, 18, 'Low');
  const t2 = insertTrip.run(activeDriver2.id, activeTripStart2, null, 'active', 12600, 3, 1, 0, 4, 0.28, 42, 'Moderate');

  db.prepare("UPDATE drivers SET status = 'safe' WHERE id = ?").run(activeDriver1.id);
  db.prepare("UPDATE drivers SET status = 'warning' WHERE id = ?").run(activeDriver2.id);

  // Insert a few live/recent events for the active trips
  insertEvent.run(t1.lastInsertRowid, activeDriver1.id, new Date(now.getTime() - 15 * 60 * 1000).toISOString(), 'warning', 'warning', 1000, 0.21, 0.40, 0.44, 'New', null, null, null);
  insertEvent.run(t2.lastInsertRowid, activeDriver2.id, new Date(now.getTime() - 8 * 60 * 1000).toISOString(), 'yawn', 'warning', 1800, 0.25, 0.68, 0.38, 'New', null, null, null);
  insertEvent.run(t2.lastInsertRowid, activeDriver2.id, new Date(now.getTime() - 2 * 60 * 1000).toISOString(), 'danger', 'danger', 1400, 0.17, 0.45, 0.72, 'New', null, null, null);

  // 6. Seed Realistic Incident Snapshots for Drivers
  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots (driver_id, trip_id, filename, filepath, trigger_type, captured_at, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const triggers = ['microsleep', 'danger', 'yawn', 'warning'];
  const snapshotsBaseDir = path.join(__dirname, 'data', 'snapshots');
  if (!fs.existsSync(snapshotsBaseDir)) {
    fs.mkdirSync(snapshotsBaseDir, { recursive: true });
  }

  for (const driver of createdDrivers) {
    const driverSnapDir = path.join(snapshotsBaseDir, driver.empId);
    if (!fs.existsSync(driverSnapDir)) {
      fs.mkdirSync(driverSnapDir, { recursive: true });
    }

    for (let s = 1; s <= 3; s++) {
      const snapTrigger = triggers[(driver.id + s) % triggers.length];
      const snapTime = new Date(now.getTime() - (s * 3600 * 24 * 2 + s * 1800) * 1000);
      const pad = n => String(n).padStart(2, '0');
      const filename = `${snapTime.getFullYear()}${pad(snapTime.getMonth()+1)}${pad(snapTime.getDate())}_${pad(snapTime.getHours())}${pad(snapTime.getMinutes())}${pad(snapTime.getSeconds())}.jpg`;
      const filepath = path.join(driverSnapDir, filename);

      const color = snapTrigger === 'microsleep' ? '#EF4444' : (snapTrigger === 'danger' ? '#F97316' : '#F59E0B');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480">
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
  <ellipse cx="320" cy="260" rx="${snapTrigger === 'yawn' ? '22' : '16'}" ry="${snapTrigger === 'yawn' ? '18' : '6'}" fill="rgba(0,0,0,0.5)" stroke="${color}" stroke-width="2"/>
  <rect x="24" y="24" width="140" height="30" rx="6" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="1.5"/>
  <text x="94" y="44" fill="${color}" font-family="system-ui, sans-serif" font-weight="700" font-size="13" text-anchor="middle">⚠️ ${snapTrigger.toUpperCase()}</text>
  <rect x="500" y="24" width="116" height="30" rx="6" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.2)"/>
  <text x="558" y="44" fill="#38BDF8" font-family="monospace" font-weight="600" font-size="12" text-anchor="middle">REC ● LIVE</text>
  <rect x="0" y="430" width="640" height="50" fill="rgba(0,0,0,0.75)"/>
  <text x="24" y="462" fill="#E2E8F0" font-family="monospace" font-size="13" font-weight="600">DRIVER: ${driver.empId} (${driver.name})</text>
  <text x="320" y="462" fill="#94A3B8" font-family="monospace" font-size="12" text-anchor="middle">${snapTime.toISOString().substring(0, 19).replace('T', ' ')}</text>
  <text x="616" y="462" fill="#38BDF8" font-family="monospace" font-size="13" font-weight="700" text-anchor="end">IN-CAB WEBCAM</text>
</svg>`;
      fs.writeFileSync(filepath, svg);

      insertSnapshot.run(
        driver.empId,
        null,
        filename,
        filepath,
        snapTrigger,
        snapTime.toISOString(),
        snapTime.toISOString()
      );
    }
  }
})();

console.log('✅ Seed completed successfully!');
console.log('\n--- Admin & Manager Credentials ---');
console.log('Admin:   admin@drowsyguard.io   / admin123');
console.log('Manager: manager@drowsyguard.io / manager123');
console.log('\n--- Driver Credentials (10 drivers) ---');
for (const d of createdDrivers) {
  console.log(`[${d.empId}] ${d.name.padEnd(20)} PIN: ${d.pin}  Vehicle: ${d.vehicle}`);
}
console.log('--------------------------------------');

db.close();
