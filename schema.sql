-- DrowsyGuard Fleet SQLite Schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'supervisor')),
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  status TEXT DEFAULT 'offline' CHECK(status IN ('offline', 'safe', 'warning', 'danger', 'microsleep')),
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  start_time DATETIME NOT NULL,
  end_time DATETIME,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
  duration_seconds INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  danger_count INTEGER DEFAULT 0,
  microsleep_count INTEGER DEFAULT 0,
  yawn_count INTEGER DEFAULT 0,
  avg_perclos REAL DEFAULT 0.0,
  risk_score INTEGER DEFAULT 0,
  risk_level TEXT DEFAULT 'Low' CHECK(risk_level IN ('Low', 'Moderate', 'High', 'Critical')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  timestamp DATETIME NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('heartbeat', 'eye_closure', 'yawn', 'head_nod', 'microsleep', 'warning', 'danger')),
  severity TEXT NOT NULL CHECK(severity IN ('normal', 'warning', 'danger', 'critical')),
  duration_ms INTEGER DEFAULT 0,
  ear REAL,
  mar REAL,
  perclos REAL,
  status TEXT DEFAULT 'New' CHECK(status IN ('New', 'Acknowledged', 'Resolved')),
  notes TEXT,
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at DATETIME
);

CREATE TABLE IF NOT EXISTS calibration_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER UNIQUE NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  baseline_ear REAL NOT NULL,
  calibrated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indices for performance
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL,
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  captured_at DATETIME NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trips_driver_id ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_start_time ON trips(start_time);
CREATE INDEX IF NOT EXISTS idx_events_trip_id ON events(trip_id);
CREATE INDEX IF NOT EXISTS idx_events_driver_id ON events(driver_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
CREATE INDEX IF NOT EXISTS idx_snapshots_driver_id ON snapshots(driver_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots(captured_at);
