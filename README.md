# 🛡️ Driver-Fatigue Detection — Real-Time Fleet Fatigue & Safety Intelligence Platform

> Enterprise multi-driver fleet fatigue monitoring platform powered by client-side **Google MediaPipe FaceMesh** telemetry, Web Audio alarms, an offline-buffered **Driver Station Kiosk**, standard webcam support, and an executive fleet management suite built on Node.js, SQLite (WAL mode), and real-time WebSockets.

---

## 📋 Table of Contents

- [Platform Overview](#-platform-overview)
- [Architecture & Data Flow](#-architecture--data-flow)
- [Directory Structure](#-directory-structure)
- [Quick Start Guide](#-quick-start-guide)
- [Demo Credentials](#-demo-credentials)
- [Role-Based Access Control (RBAC)](#-role-based-access-control-rbac)
- [Driver Station Kiosk (`/driver`)](#-driver-station-kiosk-driver)
- [Management Portal (`/admin`)](#-management-portal-admin)
- [Core Detection Telemetry](#-core-detection-telemetry)
- [API Reference](#-api-reference)
- [Risk Scoring Model](#-risk-scoring-model)
- [Troubleshooting](#-troubleshooting)

---

## 🌟 Platform Overview

Driver-Fatigue Detection protects commercial drivers and fleet operators by detecting drowsiness indicators in real time:

- **Zero-Latency In-Cab Edge Detection**: MediaPipe FaceMesh runs locally in the browser on the Driver Station tablet/laptop using standard webcams. No raw video stream needs to be sent to external servers.
- **Client-Side Face Mesh Telemetry**: Real-time Eye Aspect Ratio (EAR), Mouth Aspect Ratio (MAR), PERCLOS, blink rate, and head nod/tilt analysis.
- **Enterprise Fleet Intelligence**: Executive management portal with live driver fleet telemetry, KPI trends, 60-day historical analysis, snapshot logs, and CSV compliance reporting.
- **Standard Webcam Integration**: Seamless plug-and-play webcam access via standard browser `navigator.mediaDevices.getUserMedia`.
- **Real-Time WebSocket Link**: Dispatches instant alerts and visual cues across the fleet dashboard whenever a microsleep or critical drowsiness event occurs.

---

## 🏛️ Architecture & Data Flow

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                         DRIVER CABIN / IN-CAB STATION                           │
 │                                                                                 │
 │   Standard Webcam ──▶ MediaPipe FaceMesh ──▶ FatigueEngine (EAR/MAR/PERCLOS)   │
 │                                                        │                        │
 │                                                        ▼                        │
 │                                             AlertEngine (Audio + Kiosk)         │
 │                                                        │                        │
 └────────────────────────────────────────────────────────┼────────────────────────┘
                                            WebSocket /   │ Live Telemetry & Alerts
                                            REST Events   ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                          BACKEND INTELLIGENCE SERVER                            │
 │                               (server.js :8080)                                 │
 │                                                                                 │
 │   ┌───────────────────────┐                 ┌───────────────────────┐           │
 │   │ SQLite (better-sqlite)│                 │  Snapshot Repository  │           │
 │   │   WAL Mode DB         │                 │   data/snapshots/     │           │
 │   └───────────────────────┘                 └───────────────────────┘           │
 └────────────────────────────────────────┬────────────────────────────────────────┘
                               WebSocket  │ Live Telemetry & Incident Alerts
                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                        FLEET MANAGEMENT / ADMIN PORTAL                          │
 │                          (http://localhost:8080/admin)                          │
 │                                                                                 │
 │   Executive KPIs · Live Monitor · Incident Logs · Reports (CSV)                 │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Directory Structure

```
driver-fatigue/
├── index.html                      # Standalone client-side detection application
├── standalone.html                 # Direct browser entry point
├── package.json                    # Dependencies: better-sqlite3, jsonwebtoken, bcryptjs, ws
├── server.js                       # Native Node HTTP server, SQLite API & WS
├── schema.sql                      # Database schema (auto-initialized on server start)
├── seed.js                         # Demo seed generator (60 days of historical fleet telemetry)
├── riskScore.js                    # Standardized 0-100 driver safety risk algorithm
├── data/
│   ├── drowsyguard.db              # SQLite database file (WAL mode)
│   └── snapshots/                  # Uploaded incident snapshots
├── public/                         # Static front-end assets
│   ├── shared/
│   │   ├── tokens.css              # Design tokens (Enterprise Dark/Light color variables)
│   │   └── base.css                # Base reset, typography, and shared components
│   ├── admin/                      # Fleet Administration Portal
│   │   ├── index.html              # Admin views: Dashboard, Live Monitor, Drivers, Alerts
│   │   ├── admin.css               # Admin styling using token variables
│   │   └── admin.js                # Portal controller, Chart.js graphs
│   ├── driver/                     # In-Cab Driver Station Kiosk
│   │   ├── index.html
│   │   ├── driver.css
│   │   └── driver.js               # HUD, trip management, webcam detection
│   └── login.html                  # Unified authentication portal
├── js/                             # Core edge computer vision modules
│   ├── videoSource.js              # Webcam video stream manager
│   ├── faceDetector.js             # MediaPipe FaceMesh wrapper
│   ├── fatigueEngine.js            # EAR, MAR, PERCLOS, blink & head pose telemetry
│   └── alertEngine.js              # 4-level alert state machine & Web Audio alarm
└── tests/
    └── verify_features.js          # Core platform verification script
```

---

## ⚡ Quick Start Guide

### 1. Prerequisites
- **Node.js** v18.0.0 or higher
- Modern Chromium browser (Google Chrome, Microsoft Edge) with webcam access

### 2. Installation & Setup

```bash
# Navigate to project folder
cd driver-fatigue

# Install dependencies
npm install

# Seed demo data (company, admin, manager, 10 drivers, 60 days of historical trips)
node seed.js

# Start the platform
npm start
```

### 3. Open in Browser
- **Client Detection App**: [http://localhost:8080/](http://localhost:8080/)
- **Unified Login Portal**: [http://localhost:8080/login.html](http://localhost:8080/login.html)
- **Fleet Admin Portal**: [http://localhost:8080/admin](http://localhost:8080/admin)
- **Driver Station Kiosk**: [http://localhost:8080/driver](http://localhost:8080/driver)

---

## 🔑 Demo Credentials

Testers can log in via `/login.html` using the following pre-configured credentials:

### Management Staff (Email & Password Login)
| Role | Email Address | Password | Permissions & Access Scope |
|---|---|---|---|
| **Admin (Safety Director)** | `admin@drowsyguard.io` | `admin123` | **Full Access**: All views, driver onboarding, alert management, fleet settings. |
| **Fleet Manager** | `manager@drowsyguard.io` | `manager123` | **Fleet Oversight**: Live monitor, driver onboarding, alert acknowledgment & deletion, safety reports. |
| **Safety Supervisor** | `supervisor@drowsyguard.io` | `supervisor123` | **Supervisory Guard**: Live monitor, Alert feed (view & acknowledge), Driver profiles. Blocked from settings. |

### Commercial Drivers (Employee ID & PIN Login)
| Employee ID | Driver Name | Vehicle Assigned | 4-Digit PIN | Baseline EAR | Safety Risk Tier |
|---|---|---|---|---|---|
| `DRV-101` | James Wilson | Kenworth T680 #101 | **`1001`** | 0.31 | Low Risk |
| `DRV-102` | Sofia Rodriguez | Freightliner Cascadia #104 | **`1002`** | 0.29 | Low Risk |
| `DRV-103` | Marcus Chen | Volvo VNL 860 #109 | **`1003`** | 0.33 | Moderate Risk |
| `DRV-104` | Devon Brooks | Peterbilt 579 #112 | **`1004`** | 0.28 | Moderate Risk |
| `DRV-105` | Aaliyah Patel | Mack Anthem #115 | **`1005`** | 0.30 | Moderate Risk |
| `DRV-106` | Tyler Kowalski | International LT #118 | **`1006`** | 0.32 | High Risk |
| `DRV-107` | Chloe Dubois | Kenworth T680 #121 | **`1007`** | 0.29 | High Risk |
| `DRV-108` | Ramon Gutierrez | Freightliner Cascadia #125 | **`1008`** | 0.31 | High Risk |
| `DRV-109` | Zackariah King | Volvo VNL 760 #128 | **`1009`** | 0.30 | Critical Watch |
| `DRV-110` | Nadia Brennan | Peterbilt 579 #132 | **`1010`** | 0.32 | Low Risk |

---

## 🛡️ Role-Based Access Control (RBAC)

| Feature / Resource | Admin | Manager | Supervisor | Driver |
|---|:---:|:---:|:---:|:---:|
| **Dashboard KPIs & Charts** | ✅ Full | ✅ Full | ✅ Full | ❌ No |
| **Live Telemetry Monitor** | ✅ Full | ✅ Full | ✅ View Only | ❌ No |
| **Driver Roster & Profiles** | ✅ Add / Edit / Delete | ✅ Add / Edit | ✅ View Only | ❌ No |
| **Incident Snapshots** | ✅ View / Download | ✅ View / Download | ✅ View / Download | ❌ No |
| **Alert Feed — View / Acknowledge** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Alert Feed — Delete Record** | ✅ Yes | ✅ Yes | ❌ Forbidden (403) | ❌ No |
| **Fleet & Driver Reports (CSV)** | ✅ View / Export | ✅ View / Export | ✅ View / Export | ❌ Forbidden (403) |
| **System Settings** | ✅ Read / Write | ✅ View Only | ❌ Hidden / 403 | ❌ No |
| **Driver Station HUD** | ❌ Dispatch | ❌ Dispatch | ❌ Dispatch | ✅ Shift Active |

---

## 🎛️ Driver Station Kiosk (`/driver`)

Designed for in-cab touchscreens and vehicle tablets:
1. **Touchpad PIN Login**: Driver ID input with a virtual numeric touch keypad for 4-digit PIN authentication.
2. **Pre-Trip Calibration**: Vehicle confirmation, webcam test, and baseline EAR verification.
3. **Active Trip HUD**:
   - Webcam feed with MediaPipe FaceMesh landmark mesh overlay.
   - Real-time PERCLOS arc gauge, EAR metric, MAR yawn detector, blink frequency, and head posture indicator.
   - Full-screen flashing banner and continuous Web Audio alarm during microsleep events.

---

## 📊 Management Portal (`/admin`)

- **Dashboard**: Executive KPIs (Active drivers, today's microsleeps, fleet average risk score, total alerts), 14-day alert telemetry trend, severity donut, and hourly alert frequency.
- **Live Monitor**: Real-time telemetry cards powered by WebSockets with audible alert chime on incoming microsleep events.
- **Driver Profiles & Dossier**:
  - **Overview**: Lifetime trip hours, lifetime microsleeps, average PERCLOS, and 30-day incident bar graph.
  - **Trip Logs**: Chronological table of shifts, durations, alert counts, and safety risk scores.
  - **Incidents History**: Granular list of events with timestamps, durations, and biometric ratios.
- **Alert Feed**: Centralized queue of warning, danger, and microsleep events.
- **Compliance Reports**: Download fleet-wide audit logs or individual driver reports formatted as CSV spreadsheets.

---

## 🧠 Core Detection Telemetry

| Metric | Scientific Formula | Alert Threshold | Description |
|---|---|---|---|
| **EAR** (Eye Aspect Ratio) | `(‖p2−p6‖ + ‖p3−p5‖) / (2·‖p1−p4‖)` | `< baseline × 0.75` | Measures eye aperture relative to the driver's personal open-eye baseline. |
| **MAR** (Mouth Aspect Ratio) | `(‖p2−p6‖ + ‖p3−p5‖) / (2·‖p1−p4‖)` | `> 0.60` for 20 frames | Detects mouth opening duration characteristic of yawning. |
| **PERCLOS** | `Closed Frames ÷ Total Frames` (30s window) | `> 40%` Warning<br>`> 70%` Danger | Gold-standard physiological fatigue metric measuring percentage of eyelid closure over time. |
| **Microsleep** | Continuous closure frames | `≥ 45 frames` (~1.5s) | Dangerous loss of consciousness requiring immediate alarm intervention. |
| **Head Tilt** | Eye-corner lateral angle | `> 20°` | Lateral head sagging indicating muscle relaxation from fatigue. |
| **Head Nod** | Nose tip to chin vertical displacement | `> 15°` | Forward head nodding characteristic of nodding off. |

---

## 🔌 API Reference

### Authentication
- `POST /api/auth/admin-login` — `{ email, password }` → `{ token, user }`
- `POST /api/auth/driver-login` — `{ employee_id, pin }` → `{ token, driver }`
- `GET /api/auth/me` — Current profile

### Fleet Drivers
- `GET /api/drivers` — Returns all drivers with 7-day alert counts and current status
- `POST /api/drivers` — Onboard new commercial driver
- `GET /api/drivers/:id` — Driver dossier, lifetime stats, and 30-day incident trend
- `PUT /api/drivers/:id` — Update driver details, vehicle, or PIN
- `DELETE /api/drivers/:id` — Deactivate driver

### Trips & Telemetry
- `POST /api/trips` — Start trip shift for active driver
- `PATCH /api/trips/:id/end` — Conclude trip, compute risk score and statistics
- `POST /api/events/batch` — Ingest telemetry heartbeats and incident events

### Incident Snapshots
- `POST /api/snapshots/upload` — Multipart form upload (`driver_id`, `trigger`, `snapshot` file)
- `POST /api/snapshots/trigger` — Trigger incident event notification
- `GET /api/snapshots/:driver_id` — List all incident snapshots for a driver
- `GET /api/snapshots/image/:id` — Stream high-res JPEG binary

### Executive Statistics & Reports
- `GET /api/stats/overview` — Executive KPIs (Active drivers, today's alerts, average risk score)
- `GET /api/stats/live` — Active drivers currently on shift with real-time telemetry
- `GET /api/stats/alerts-over-time` — 14-day alert trend line, severity donut, and hourly distribution
- `GET /api/reports?format=csv` — Download fleet trip log as a CSV spreadsheet
- `GET /api/settings` — Read detection thresholds
- `PATCH /api/settings` — Save updated thresholds

### WebSockets
- `ws://localhost:8080/ws` — Real-time event streaming (`trip_started`, `trip_ended`, `live_telemetry`, `microsleep_alert`)

---

## 📈 Risk Scoring Model

Located in [`riskScore.js`](file:///d:/driver-fatigue/riskScore.js), the risk engine produces a standardized 0–100 integer score:
- **Microsleeps (Weight ×4)**: 15 points per event (max 45)
- **Danger Events (Weight ×2)**: 7 points per event (max 30)
- **Warning Events (Weight ×1)**: 2 points per event (max 15)
- **Elevated PERCLOS**: Progressive scale beginning above 10% average closure (max 25)
- **Excessive Yawning**: 3 points per yawn beyond normal baseline of 2 (max 15)
- **Shift Overtime (>4 hours)**: +5 points per hour beyond 4 hours (max 15)

| Score Range | Risk Classification | Action Required |
|---|---|---|
| **0 – 24** | 🟢 **Low** | Nominal alertness; safe operation |
| **25 – 49** | 🟡 **Moderate** | Elevated fatigue markers; advisory rest break |
| **50 – 74** | 🟠 **High** | Dangerous fatigue pattern; mandatory stop |
| **75 – 100** | 🔴 **Critical** | Microsleep / severe exhaustion; vehicle intervention |

---

## 🚀 Deploying to GitHub & Vercel

### 1. Push to GitHub
```bash
git add .
git commit -m "feat: complete webcam-only driver fatigue monitoring platform"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git
git push -u origin main
```

### 2. Deploy to Vercel
1. Go to [vercel.com](https://vercel.com) and click **"Add New Project"**.
2. Select your imported GitHub repository.
3. Framework Preset: Leave as **"Other"** (or None). Root Directory: `./`.
4. Click **"Deploy"**.
5. All rewrites in [`vercel.json`](file:///d:/driver-fatigue/vercel.json) automatically route:
   - `/` → Main Camera Detector
   - `/login` → Unified Common Login Portal
   - `/admin` → Fleet Admin Intelligence Portal
   - `/driver` → Driver In-Cab Kiosk Station
   - `/api/*` → Serverless Function backend ([`api/index.js`](file:///d:/driver-fatigue/api/index.js))

---

## 🔧 Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| `Port 8080 is already in use` | Another server instance is active | Run in PowerShell: `$p = Get-NetTCPConnection -LocalPort 8080 -State Listen \| Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force }` |
| `Cannot find module 'better-sqlite3'` | Dependencies not installed | Run `npm install` in the project root directory |
| Camera permission denied | Browser blocked webcam | Ensure camera permissions are allowed in your browser settings |
| Web Audio tones not playing | Browser autoplay policy | Click anywhere on the Driver Station or Start button to grant audio permissions |

---

## 📄 License
Personal and educational use. Built with open-source MediaPipe FaceMesh computer vision libraries.
