# 🛡️ Driver-Fatigue Detection — Real-Time Fleet Fatigue & Safety Intelligence Platform

> Enterprise multi-driver fleet fatigue monitoring platform powered by client-side **Google MediaPipe FaceMesh** telemetry, Web Audio alarms, an offline-buffered **Driver Station Kiosk**, **ESP32-CAM incident snapshot storage on SD card**, and an executive fleet management suite built on Node.js, SQLite (WAL mode), and real-time WebSockets.

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
- [SD Card & Incident Snapshot Engine](#-sd-card--incident-snapshot-engine)
- [Hardware & ESP32-CAM Streaming](#-hardware--esp32-cam-streaming)
- [Core Detection Telemetry](#-core-detection-telemetry)
- [API Reference](#-api-reference)
- [Risk Scoring Model](#-risk-scoring-model)
- [Troubleshooting](#-troubleshooting)

---

## 🌟 Platform Overview

Driver-Fatigue Detection protects commercial drivers and fleet operators by detecting drowsiness indicators in real time:

- **Zero-Latency In-Cab Edge Detection**: MediaPipe FaceMesh runs locally in the browser on the Driver Station tablet/laptop. No continuous raw video stream is uploaded to the cloud.
- **ESP32-CAM Incident Snapshots & SD Logging**: When critical fatigue or microsleep is detected, the ESP32 camera triggers a high-resolution SVGA snapshot, writes it locally to an onboard SD card, and syncs it to the fleet database via multipart upload.
- **SD Card Zero-Code WiFi Config**: Insert a micro-SD card formatted to FAT32 with `config.txt` to configure WiFi credentials, server IP, and Driver ID without reflashing.
- **Enterprise Fleet Intelligence**: Executive management portal with live driver fleet telemetry, KPI trends, 60-day historical analysis, snapshot gallery with lightbox modal, and CSV compliance reporting.
- **Dual Camera Support**: Connect to in-cab USB webcams or dedicated wireless ESP32-CAM video feeds through an integrated zero-CORS MJPEG reverse proxy.
- **Real-Time WebSocket Link**: Dispatches instant alerts and full-screen flashing cues across the fleet dashboard whenever a microsleep or critical drowsiness event occurs.

---

## 🏛️ Architecture & Data Flow

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                         DRIVER CABIN / IN-CAB STATION                           │
 │                                                                                 │
 │   Webcam / ESP32 ──▶ MediaPipe FaceMesh ──▶ FatigueEngine (EAR/MAR/PERCLOS)    │
 │                                                        │                        │
 │                                                        ▼                        │
 │                                             AlertEngine (Audio + Kiosk)         │
 │                                                        │                        │
 └────────────────────────────────────────────────────────┼────────────────────────┘
                               HTTP /api/snapshots/trigger│ (Microsleep / Danger)
                                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                      ESP32-CAM HARDWARE & SD CARD STORAGE                       │
 │                                                                                 │
 │   - Reads /config.txt on boot for WiFi & Server IP                              │
 │   - 1-Bit SD MMC Mode (SD_MMC.begin("/sdcard", true))                           │
 │   - Captures SVGA Incident Snapshot & restores VGA stream immediately           │
 │   - Saves locally to /sdcard/incidents/snap_<timestamp>.jpg                     │
 │   - Streams multipart POST /api/snapshots/upload to Backend                     │
 └────────────────────────────────────────┬────────────────────────────────────────┘
                                          │ Multipart Upload & Telemetry Batch
                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                          BACKEND INTELLIGENCE SERVER                            │
 │                               (server.js :8080)                                 │
 │                                                                                 │
 │   ┌───────────────────────┐   ┌───────────────────────┐   ┌─────────────────┐   │
 │   │ SQLite (better-sqlite)│   │  Snapshot Repository  │   │ ESP32 Reverse   │   │
 │   │   WAL Mode DB         │   │   data/snapshots/     │   │ Proxy (/esp32)  │   │
 │   └───────────────────────┘   └───────────────────────┘   └─────────────────┘   │
 └────────────────────────────────────────┬────────────────────────────────────────┘
                               WebSocket  │ Live Telemetry & Incident Alerts
                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                        FLEET MANAGEMENT / ADMIN PORTAL                          │
 │                          (http://localhost:8080/admin)                          │
 │                                                                                 │
 │   Executive KPIs · Live Monitor · Incident Gallery & Lightbox · Reports (CSV)   │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Directory Structure

```
driver-fatigue/
├── config.json                     # ESP32-CAM stream URL config
├── package.json                    # Dependencies: better-sqlite3, jsonwebtoken, bcryptjs, ws
├── server.js                       # Native Node HTTP server, SQLite API, WS, & ESP32 proxy
├── schema.sql                      # Database schema (auto-initialized on server start)
├── seed.js                         # Demo seed generator (60 days of historical fleet telemetry)
├── riskScore.js                    # Standardized 0-100 driver safety risk algorithm
├── data/
│   ├── drowsyguard.db              # SQLite database file (WAL mode)
│   └── snapshots/                  # Uploaded incident snapshots (<driver_id>/<YYYYMMDD_HHMMSS>.jpg)
├── public/                         # Static front-end assets
│   ├── shared/
│   │   ├── tokens.css              # Design tokens (Enterprise Dark/Light color variables)
│   │   └── base.css                # Base reset, typography, and shared components
│   ├── admin/                      # Fleet Administration Portal
│   │   ├── index.html              # Admin views: Dashboard, Live Monitor, Drivers, Alerts, Snapshots
│   │   ├── admin.css               # Admin styling using token variables
│   │   └── admin.js                # Portal controller, Chart.js graphs, Lightbox dialog
│   ├── driver/                     # In-Cab Driver Station Kiosk
│   │   ├── index.html
│   │   ├── driver.css
│   │   └── driver.js               # HUD, trip management, fire-and-forget snapshot trigger
│   └── login.html                  # Unified authentication portal
├── js/                             # Core edge computer vision modules (untouched)
│   ├── videoSource.js              # Video stream abstraction (Webcam / ESP32)
│   ├── faceDetector.js             # MediaPipe FaceMesh wrapper
│   ├── fatigueEngine.js            # EAR, MAR, PERCLOS, blink & head pose telemetry
│   └── alertEngine.js              # 4-level alert state machine & Web Audio alarm
├── firmware/                       # ESP32-CAM Firmware & SD Card Config
│   ├── config.txt                  # Sample SD card configuration file
│   ├── FLASH_INSTRUCTIONS.md       # Arduino IDE & ESP-IDF flashing guide
│   └── CameraWebServer/
│       ├── CameraWebServer.ino     # Production firmware with SD MMC & /trigger-snapshot
│       ├── camera_pins.h           # AI-Thinker pin mappings
│       └── board_config.h
└── tests/
    ├── verify_features.js          # Core platform verification script
    └── verify_phase2_snapshots.js  # Snapshot upload & proxy verification test
```

---

## ⚡ Quick Start Guide

### 1. Prerequisites
- **Node.js** v18.0.0 or higher
- Modern Chromium browser (Google Chrome or Microsoft Edge)
- ESP32-CAM with micro-SD card *(optional; built-in webcam supported)*

### 2. Installation & Setup

```bash
# Navigate to project folder
cd d:\IOT\driver-fatigue

# Install dependencies
npm install

# Seed demo data (company, admin, manager, 10 drivers, 60 days of historical trips)
node seed.js

# Start the platform
npm start
```

### 3. Open in Browser
- **Unified Login Portal**: [http://localhost:8080/login.html](http://localhost:8080/login.html)
- **Fleet Admin Portal**: [http://localhost:8080/admin](http://localhost:8080/admin)
- **Driver Station Kiosk**: [http://localhost:8080/driver](http://localhost:8080/driver)
- **ESP32 Proxy Stream**: [http://localhost:8080/esp32/stream](http://localhost:8080/esp32/stream)

---

## 🔑 Demo Credentials

Testers can log in via `/login.html` using the following pre-configured credentials:

### Management Staff (Email & Password Login)
| Role | Email Address | Password | Permissions & Access Scope |
|---|---|---|---|
| **Admin (Safety Director)** | `admin@drowsyguard.io` | `admin123` | **Full Access**: All views, driver onboarding, alert management, snapshot gallery, camera settings. |
| **Fleet Manager** | `manager@drowsyguard.io` | `manager123` | **Fleet Oversight**: Live monitor, driver onboarding, alert acknowledgment & deletion, safety reports. |
| **Safety Supervisor** | `supervisor@drowsyguard.io` | `supervisor123` | **Supervisory Guard**: Live monitor, Alert feed (view & acknowledge), Driver profiles & snapshots. Blocked from settings. |

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
| **Incident Snapshot Gallery & Lightbox** | ✅ View / Download | ✅ View / Download | ✅ View / Download | ❌ No |
| **Alert Feed — View / Acknowledge** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Alert Feed — Delete Record** | ✅ Yes | ✅ Yes | ❌ Forbidden (403) | ❌ No |
| **Fleet & Driver Reports (CSV)** | ✅ View / Export | ✅ View / Export | ✅ View / Export | ❌ Forbidden (403) |
| **System Settings & ESP32 Config** | ✅ Read / Write | ✅ View Only | ❌ Hidden / 403 | ❌ No |
| **Driver Station HUD & Camera Tuning** | ❌ Dispatch | ❌ Dispatch | ❌ Dispatch | ✅ Shift Active |

---

## 💾 SD Card & Incident Snapshot Engine

### 1. Zero-Code SD Card WiFi Configuration
Place a file named `config.txt` in the root of a FAT32-formatted micro-SD card:

```ini
# DrowsyGuard ESP32-CAM Configuration
WIFI_SSID=YourWiFiNetwork
WIFI_PASS=YourWiFiPassword
SERVER_IP=192.168.1.100
SERVER_PORT=8080
DRIVER_ID=DRV-101
```

- When the ESP32-CAM boots, it reads `config.txt` and connects automatically.
- Falls back to hardcoded firmware credentials if the SD card is not present.
- Appends boot diagnostics and assigned IP address to `/boot_log.txt`.

### 2. 1-Bit SD MMC Mode (Hardware Safe)
- ESP32-CAM uses `SD_MMC.begin("/sdcard", true)` (1-bit bus mode).
- Leaves **GPIO 4** free from bus contention, preventing the onboard white LED from blinding the driver or flickering during disk operations.

### 3. Incident Snapshot Lifecycle
1. **Trigger**: When the In-Cab Station detects a `microsleep` or `danger` condition, it sends a non-blocking request to `POST /api/snapshots/trigger`.
2. **High-Res Capture**: The ESP32 switches resolution to **SVGA (800x600)**, grabs a clean high-detail frame, and immediately switches back to the streaming resolution (**VGA 640x480**) so the driver HUD video stream remains uninterrupted.
3. **Local Storage**: The image is saved to `/incidents/snap_<timestamp>.jpg` on the SD card.
4. **Server Sync**: The ESP32 uploads the JPEG via HTTP multipart to `POST /api/snapshots/upload`.
5. **Database Correlation**: The backend associates the snapshot with the driver and their active trip in the SQLite `snapshots` table.

---

## 🎛️ Driver Station Kiosk (`/driver`)

Designed for in-cab touchscreens and vehicle tablets:
1. **Touchpad PIN Login**: Driver ID input with a virtual numeric touch keypad for 4-digit PIN authentication.
2. **Pre-Trip Calibration**: Vehicle confirmation, camera preview (Webcam or ESP32-CAM), and baseline EAR verification.
3. **Active Trip HUD**:
   - Camera feed with MediaPipe FaceMesh landmark mesh overlay.
   - Real-time PERCLOS arc gauge, EAR metric, MAR yawn detector, blink frequency, and head posture indicator.
   - Full-screen flashing banner and continuous Web Audio alarm during microsleep events.
   - Fire-and-forget snapshot trigger to ESP32 on severe fatigue transitions with an 8-second cooldown gate.
4. **Camera Tuning Drawer**: Real-time slider adjustments for saturation, contrast, brightness, compression quality, and one-click auto-calibration.

---

## 📊 Management Portal (`/admin`)

- **Dashboard**: Executive KPIs (Active drivers, today's microsleeps, fleet average risk score, total alerts), 14-day alert telemetry trend, severity donut, and hourly alert frequency.
- **Live Monitor**: Real-time telemetry cards powered by WebSockets with audible alert chime on incoming microsleep events.
- **Driver Profiles & Dossier**:
  - **Overview**: Lifetime trip hours, lifetime microsleeps, average PERCLOS, and 30-day incident bar graph.
  - **Trip Logs**: Chronological table of shifts, durations, alert counts, and safety risk scores.
  - **Incidents History**: Granular list of events with timestamps, durations, and biometric ratios.
  - **📷 Snapshots Tab**: Photo grid gallery displaying all incident captures for the selected driver with pulse skeleton loaders and severity badges.
  - **Full-Resolution Lightbox**: Click any snapshot to view the high-resolution frame with metadata and a direct download button.
- **Alert Feed**: Centralized queue of warning, danger, and microsleep events. Includes an interactive `📷 Snapshot` button to jump straight to the incident photo in the lightbox.
- **Compliance Reports**: Download fleet-wide audit logs or individual driver reports formatted as CSV spreadsheets.

---

## 📡 Hardware & ESP32-CAM Streaming

The ESP32-CAM module transmits an MJPEG video stream over WiFi. The Node backend relays this stream to eliminate browser CORS and mixed-content restrictions.

### Setup Instructions
1. Upload [`firmware/CameraWebServer/CameraWebServer.ino`](file:///d:/IOT/driver-fatigue/firmware/CameraWebServer/CameraWebServer.ino) using Arduino IDE (`Board: AI Thinker ESP32-CAM`, `PSRAM: Enabled`). Refer to [`firmware/FLASH_INSTRUCTIONS.md`](file:///d:/IOT/driver-fatigue/firmware/FLASH_INSTRUCTIONS.md) for full flashing instructions.
2. Format a micro-SD card (FAT32), create [`config.txt`](file:///d:/IOT/driver-fatigue/firmware/config.txt), and insert it into the camera.
3. Open Serial Monitor at 115200 baud to verify the assigned IP address (e.g., `10.15.80.91`).
4. Update [`config.json`](file:///d:/IOT/driver-fatigue/config.json) with your camera stream URL:
   ```json
   {
     "esp32Stream": "http://10.15.80.91:81/stream"
   }
   ```
5. View the proxied stream in any browser at `http://localhost:8080/esp32/stream`.

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

### Incident Snapshots & SD Sync
- `POST /api/snapshots/upload` — Multipart form upload from ESP32-CAM (`driver_id`, `trigger`, `snapshot` file)
- `POST /api/snapshots/trigger` — Proxy trigger to ESP32-CAM `/trigger-snapshot`
- `GET /api/snapshots/:driver_id` — List all incident snapshots for a driver (newest first)
- `GET /api/snapshots/image/:id` — Stream high-res JPEG binary (`Bearer <token>` or `?token=<token>`)

### Camera Controls
- `POST /api/camera/tune` — Apply optimal tuning presets (quality: 10, saturation: 1, contrast: 1, sharpness: 1)
- `POST /api/camera/control` — Adjust single camera register (`{ var, val }`)
- `GET /api/camera/status` — Get live camera sensor registers

### Executive Statistics & Reports
- `GET /api/stats/overview` — Executive KPIs (Active drivers, today's alerts, average risk score)
- `GET /api/stats/live` — Active drivers currently on shift with real-time telemetry
- `GET /api/stats/alerts-over-time` — 14-day alert trend line, severity donut, and hourly distribution
- `GET /api/reports?format=csv` — Download fleet trip log as a CSV spreadsheet
- `GET /api/settings` — Read detection thresholds and camera configuration
- `PATCH /api/settings` — Save updated thresholds and camera stream URLs

### WebSockets
- `ws://localhost:8080/ws` — Real-time event streaming (`trip_started`, `trip_ended`, `live_telemetry`, `microsleep_alert`)

---

## 📈 Risk Scoring Model

Located in [`riskScore.js`](file:///d:/IOT/driver-fatigue/riskScore.js), the risk engine produces a standardized 0–100 integer score:
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

## 🔧 Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| `Port 8080 is already in use` | Another server instance is active | Run in PowerShell: `$p = Get-NetTCPConnection -LocalPort 8080 -State Listen \| Select-Object -ExpandProperty OwningProcess; Stop-Process -Id $p -Force` |
| `Cannot find module 'better-sqlite3'` | Dependencies not installed | Run `npm install` in the project root directory |
| ESP32 stream fails to load | Incorrect camera IP or subnet mismatch | Check assigned IP in Serial Monitor and verify [`config.json`](file:///d:/IOT/driver-fatigue/config.json) |
| SD Card not detected | Card format incompatible | Format micro-SD card as **FAT32** (32GB or smaller recommended) |
| Flash LED blinks or stays on | GPIO 4 conflict | Verify firmware is using `SD_MMC.begin("/sdcard", true)` (1-bit mode) |
| Camera shows dark video | Low in-cab illumination | Click **Auto-Tune Camera** in Driver HUD or call `POST /api/camera/tune` |
| Web Audio tones not playing | Browser autoplay policy | Click anywhere on the Driver Station or Start Shift button to grant audio permissions |

---

## 📄 License
Personal and educational use. Built with open-source MediaPipe FaceMesh computer vision libraries.
