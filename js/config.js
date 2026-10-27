/**
 * Centralized Configuration Module
 * Loads settings from /config.json with fallback defaults.
 * Allows easy future modification of stream links in one place.
 */

export const DEFAULT_CONFIG = {
  esp32Stream: "http://10.15.80.91",
  esp32StreamUrl: "http://10.15.80.91:81/stream",
  esp32SnapshotUrl: "http://10.15.80.91/capture",
  esp32TriggerSnapshotUrl: "http://10.15.80.91/trigger-snapshot",
  proxyStreamUrl: "/esp32/stream"
};

let cachedConfig = null;

/**
 * Resolves a full configuration object from any stream/camera URL string.
 */
export function parseEsp32Config(inputUrl = "http://10.15.80.91") {
  let urlStr = String(inputUrl || "").trim();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = "http://" + urlStr;
  }

  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    const port = parsed.port;
    const path = parsed.pathname;

    // If port 81 or /stream was already specified, keep it
    let streamUrl = urlStr;
    if (!port && (!path || path === "/")) {
      streamUrl = `http://${host}:81/stream`;
    } else if (port === "80" && (!path || path === "/")) {
      streamUrl = `http://${host}:81/stream`;
    }

    const baseUrl = `http://${host}`;
    return {
      esp32Stream: inputUrl,
      host,
      baseUrl,
      esp32StreamUrl: streamUrl,
      esp32SnapshotUrl: `${baseUrl}/capture`,
      esp32TriggerSnapshotUrl: `${baseUrl}/trigger-snapshot`,
      proxyStreamUrl: "/esp32/stream"
    };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Fetch centralized configuration from /config.json or /api/config
 */
export async function loadAppConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const res = await fetch("/config.json?t=" + Date.now());
    if (res.ok) {
      const data = await res.json();
      const parsed = parseEsp32Config(data.esp32Stream || data.esp32StreamUrl || DEFAULT_CONFIG.esp32Stream);
      cachedConfig = { ...DEFAULT_CONFIG, ...data, ...parsed };
      if (typeof window !== "undefined") window.APP_CONFIG = cachedConfig;
      return cachedConfig;
    }
  } catch (err) {
    console.warn("[Config] Failed to fetch /config.json, using defaults:", err.message);
  }

  cachedConfig = { ...DEFAULT_CONFIG };
  if (typeof window !== "undefined") window.APP_CONFIG = cachedConfig;
  return cachedConfig;
}

// Preload immediately if running in browser
if (typeof window !== "undefined") {
  loadAppConfig().catch(() => {});
}
