## How to Upload Firmware to ESP32-CAM

### Arduino IDE Settings
| Setting | Value |
|---|---|
| Board | AI Thinker ESP32-CAM |
| Partition Scheme | Huge APP (3MB No OTA/1MB SPIFFS) |
| PSRAM | Enabled |
| Upload Speed | 921600 |
| Flash Mode | QIO |
| Port | Your COM port (check Device Manager) |

### Upload Steps
1. Plug ESP32-CAM into PC via USB
2. Open Arduino IDE
3. File → Open → firmware/CameraWebServer/CameraWebServer.ino
4. Set board settings from table above
5. Click Upload arrow →
6. Wait for "Done uploading"
7. Tools → Serial Monitor → set baud to 115200
8. Press RST button on ESP32-CAM board

### Confirm Success
You should see in Serial Monitor:
```text
==========================================
  🛡️  DrowsyGuard ESP32-CAM Starting...   
==========================================
[SD] SD_MMC mounted successfully (Type: ...)
[SD] Reading /config.txt...
[SD] Config loaded: SSID=Dharun, Server=10.230.138.94:8080, DriverID=EMP001
...
Connecting to WiFi: Dharun....
[WiFi] Connected successfully!
[WiFi] IP Address: 10.15.80.91
[SD] Boot event appended to /boot_log.txt
[HTTP] Registered endpoints: /trigger-snapshot & /list-snapshots
------------------------------------------
Camera Ready! Connect to 'http://10.15.80.91'
Stream URL:   'http://10.15.80.91:81/stream'
Snapshots:    'http://10.15.80.91/trigger-snapshot'
------------------------------------------
```
