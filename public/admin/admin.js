/**
 * DrowsyGuard Fleet — Admin Portal Client Controller
 * Wires authentication, hash navigation, live WebSocket telemetry, Chart.js visualizations, and fleet management.
 */

'use strict';

// ── Authentication Route Guard ─────────────────────────────────────────────
const token = localStorage.getItem('drowsyguard_token');
const userJson = localStorage.getItem('drowsyguard_user');

if (!token) {
  window.location.replace('/login.html');
}

const currentUser = userJson ? JSON.parse(userJson) : { name: 'Director', role: 'admin' };
document.getElementById('userName').textContent = currentUser.name || 'Safety Director';
document.getElementById('userRole').textContent = (currentUser.role || 'Admin').toUpperCase();
document.getElementById('userAvatar').textContent = (currentUser.name || 'AD').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

function applyRoleRestrictions() {
  if (currentUser.role === 'supervisor') {
    const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
    if (settingsNav) settingsNav.style.display = 'none';

    const addDriverBtn = document.getElementById('openAddDriverBtn');
    if (addDriverBtn) addDriverBtn.style.display = 'none';
  }
}
applyRoleRestrictions();

// ── API Fetch Helper ───────────────────────────────────────────────────────
async function api(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const res = await fetch(endpoint, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('drowsyguard_token');
    localStorage.removeItem('drowsyguard_user');
    window.location.replace('/login.html');
    return null;
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'API Request failed');
  }
  return data;
}

// ── Toast Notification Helper ──────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Audio Alert for Fleet Dispatcher ───────────────────────────────────────
let audioCtx = null;
function playAlarmTone() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (_) {}
}

// ── Theme Management ──────────────────────────────────────────────────────
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('drowsyguard-theme', theme);
  if (themeIcon) themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
}

const savedTheme = localStorage.getItem('drowsyguard-theme') || 'dark';
applyTheme(savedTheme);

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
  updateChartThemes();
});

// ── Sign Out ──────────────────────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('drowsyguard_token');
  localStorage.removeItem('drowsyguard_user');
  window.location.replace('/login.html');
});

// ── Navigation Routing ────────────────────────────────────────────────────
const navItems = document.querySelectorAll('.nav-item');
const viewSections = {
  dashboard: document.getElementById('viewDashboard'),
  live: document.getElementById('viewLive'),
  drivers: document.getElementById('viewDrivers'),
  driverProfile: document.getElementById('viewDriverProfile'),
  alerts: document.getElementById('viewAlerts'),
  reports: document.getElementById('viewReports'),
  settings: document.getElementById('viewSettings'),
};

const viewTitles = {
  dashboard: 'Fleet Safety Overview',
  live: 'Live In-Cab Telemetry',
  drivers: 'Commercial Driver Roster',
  driverProfile: 'Operator Performance Dossier',
  alerts: 'Real-Time Alert Feed',
  reports: 'Safety & Compliance Reports',
  settings: 'System Configuration',
};

function navigate() {
  const hash = window.location.hash.slice(1) || 'dashboard';
  let route = hash;
  let param = null;

  if (hash.startsWith('drivers/')) {
    route = 'driverProfile';
    param = hash.split('/')[1];
  }

  if (currentUser.role === 'supervisor' && route === 'settings') {
    showToast('Supervisors do not have access to System Settings', 'warning');
    window.location.hash = '#dashboard';
    return;
  }

  // Update nav active state
  navItems.forEach(item => {
    const v = item.getAttribute('data-view');
    item.classList.toggle('active', v === route || (v === 'drivers' && route === 'driverProfile'));
  });

  // Switch view section
  Object.keys(viewSections).forEach(key => {
    if (viewSections[key]) {
      viewSections[key].classList.toggle('active', key === route);
    }
  });

  document.getElementById('pageTitle').textContent = viewTitles[route] || 'Fleet Management';

  // Load view data
  if (route === 'dashboard') loadDashboard();
  else if (route === 'live') loadLiveMonitor();
  else if (route === 'drivers') loadDrivers();
  else if (route === 'driverProfile' && param) loadDriverProfile(param);
  else if (route === 'alerts') loadAlertsFeed();
  else if (route === 'reports') loadReports();
  else if (route === 'settings') loadSettings();
}

window.addEventListener('hashchange', navigate);

// ── View 1: Dashboard Controller ──────────────────────────────────────────
let trendChartInstance = null;
let donutChartInstance = null;
let hourlyChartInstance = null;

async function loadDashboard() {
  try {
    const [overview, charts] = await Promise.all([
      api('/api/stats/overview'),
      api('/api/stats/alerts-over-time'),
    ]);

    if (!overview || !charts) return;

    // Update KPI Cards
    document.getElementById('kpiActiveDrivers').textContent = overview.activeDriversNow;
    document.getElementById('kpiMicrosleeps').textContent = overview.microsleepsToday;
    const msTrendEl = document.getElementById('kpiMicrosleepsTrend');
    msTrendEl.textContent = `${overview.microsleepsTrend >= 0 ? '+' : ''}${overview.microsleepsTrend} vs yesterday`;
    msTrendEl.className = `kpi-trend ${overview.microsleepsTrend > 0 ? 'negative' : 'positive'}`;

    document.getElementById('kpiAvgRisk').textContent = overview.avgFleetRiskScore;
    document.getElementById('kpiTotalAlerts').textContent = overview.totalAlertsToday;
    const alTrendEl = document.getElementById('kpiAlertsTrend');
    alTrendEl.textContent = `${overview.totalAlertsTrend >= 0 ? '+' : ''}${overview.totalAlertsTrend} vs yesterday`;

    // Render Charts
    renderTrendChart(charts.last14Days);
    renderDonutChart(charts.severityToday);
    renderHourlyChart(charts.hourlyAlerts);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function updateChartThemes() {
  if (trendChartInstance) trendChartInstance.update();
  if (donutChartInstance) donutChartInstance.update();
  if (hourlyChartInstance) hourlyChartInstance.update();
}

function renderTrendChart(days = []) {
  const ctx = document.getElementById('trendChart').getContext('2d');
  if (trendChartInstance) trendChartInstance.destroy();

  const labels = days.map(d => d.day.slice(5)); // MM-DD
  const warnings = days.map(d => d.warnings);
  const dangers = days.map(d => d.dangers);
  const microsleeps = days.map(d => d.microsleeps);

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Warnings', data: warnings, borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,0.1)', tension: 0.3, fill: true },
        { label: 'Dangers', data: dangers, borderColor: '#F97316', backgroundColor: 'rgba(249,115,22,0.1)', tension: 0.3, fill: true },
        { label: 'Microsleeps', data: microsleeps, borderColor: '#EF4444', backgroundColor: 'rgba(239,68,68,0.2)', tension: 0.3, fill: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { family: 'Inter', size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(100,116,139,0.1)' }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } },
      },
    },
  });
}

function renderDonutChart(severity = {}) {
  const ctx = document.getElementById('severityDonutChart').getContext('2d');
  if (donutChartInstance) donutChartInstance.destroy();

  donutChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Warnings', 'Danger', 'Critical (Microsleep)'],
      datasets: [{
        data: [severity.warning || 0, severity.danger || 0, severity.critical || 0],
        backgroundColor: ['#F59E0B', '#F97316', '#EF4444'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { family: 'Inter', size: 11 } } } },
      cutout: '70%',
    },
  });
}

function renderHourlyChart(hourly = []) {
  const ctx = document.getElementById('hourlyBarChart').getContext('2d');
  if (hourlyChartInstance) hourlyChartInstance.destroy();

  const labels = hourly.map(h => `${h.hour}:00`);
  const counts = hourly.map(h => h.count);

  hourlyChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Incident Frequency',
        data: counts,
        backgroundColor: '#4F8EF7',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(100,116,139,0.1)' } },
      },
    },
  });
}

// ── View 2: Live Monitor Controller ───────────────────────────────────────
async function loadLiveMonitor() {
  const container = document.getElementById('liveGridContainer');
  try {
    const data = await api('/api/stats/live');
    if (!data || !data.activeDrivers || data.activeDrivers.length === 0) {
      container.innerHTML = '<p class="card-subtitle" style="grid-column: 1 / -1; text-align: center; padding: 40px;">No drivers currently on active trips.</p>';
      return;
    }

    container.innerHTML = data.activeDrivers.map(d => {
      const minutes = Math.floor(d.trip_elapsed_seconds / 60);
      const isAlert = d.status === 'microsleep' || d.status === 'danger';

      return `
        <div class="card live-card ${isAlert ? 'microsleep-alert' : ''}" id="liveCard-${d.id}">
          <div class="live-card-header">
            <div class="driver-mini-profile">
              <div class="user-avatar" style="background: var(--surface-3); font-size: 13px;">
                ${d.name.split(' ').map(n=>n[0]).join('')}
              </div>
              <div>
                <a href="#drivers/${d.id}" style="color: var(--text); font-weight: 600; text-decoration: none;">
                  ${d.name}
                </a>
                <div class="card-subtitle num">${d.employee_id} · ${d.vehicle}</div>
              </div>
            </div>
            <span class="status-chip ${d.status}">${d.status}</span>
          </div>

          <div class="live-metrics-row">
            <div>
              <div class="metric-label-mini">PERCLOS</div>
              <div class="metric-val-mini num" id="livePerclos-${d.id}">${(d.perclos * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div class="metric-label-mini">Shift Time</div>
              <div class="metric-val-mini num">${minutes}m</div>
            </div>
            <div>
              <div class="metric-label-mini">Warnings</div>
              <div class="metric-val-mini num">${d.warnings}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── View 3: Drivers Roster Controller ─────────────────────────────────────
let driversCache = [];
async function loadDrivers() {
  const tbody = document.getElementById('driversTableBody');
  try {
    const data = await api('/api/drivers');
    if (!data || !data.drivers) return;
    driversCache = data.drivers;
    renderDriversTable(driversCache);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderDriversTable(list) {
  const tbody = document.getElementById('driversTableBody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No matching drivers found.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(d => `
    <tr>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="user-avatar" style="width: 28px; height: 28px; font-size: 11px;">
            ${d.name.split(' ').map(n=>n[0]).join('')}
          </div>
          <a href="#drivers/${d.id}" style="color: var(--text); font-weight: 600; text-decoration: none;">
            ${d.name}
          </a>
        </div>
      </td>
      <td class="num">${d.employee_id}</td>
      <td>${d.vehicle}</td>
      <td><span class="status-chip ${d.status}">${d.status}</span></td>
      <td><span class="risk-badge ${d.last_risk_level.toLowerCase()}">${d.last_risk_level} (${d.last_risk_score})</span></td>
      <td class="num">${d.alerts_7d}</td>
      <td class="num" style="color: ${d.microsleeps_7d > 0 ? 'var(--critical)' : 'inherit'}; font-weight: 600;">
        ${d.microsleeps_7d}
      </td>
      <td>
        <div style="display: flex; gap: 6px; align-items: center;">
          <a href="#drivers/${d.id}" class="btn btn-secondary btn-sm">View Dossier</a>
          <button type="button" class="btn btn-secondary btn-sm" onclick="downloadDriverReport('${d.id}')" title="Download Driver Report">📄 Report</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// Global search filtering
document.getElementById('globalSearch').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) {
    renderDriversTable(driversCache);
    return;
  }
  const filtered = driversCache.filter(d =>
    d.name.toLowerCase().includes(q) ||
    d.employee_id.toLowerCase().includes(q) ||
    d.vehicle.toLowerCase().includes(q)
  );
  renderDriversTable(filtered);
});

// Add Driver Modal
const addDriverModal = document.getElementById('addDriverModal');
document.getElementById('openAddDriverBtn').addEventListener('click', () => addDriverModal.classList.add('active'));
document.getElementById('closeAddDriverBtn').addEventListener('click', () => addDriverModal.classList.remove('active'));
document.getElementById('cancelAddDriverBtn').addEventListener('click', () => addDriverModal.classList.remove('active'));

document.getElementById('addDriverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const employee_id = document.getElementById('newEmpId').value.trim();
  const name = document.getElementById('newName').value.trim();
  const pin = document.getElementById('newPin').value.trim();
  const vehicle = document.getElementById('newVehicle').value.trim();

  try {
    await api('/api/drivers', {
      method: 'POST',
      body: JSON.stringify({ employee_id, name, pin, vehicle, baseline_ear: 0.30 })
    });
    addDriverModal.classList.remove('active');
    showToast('Driver successfully onboarded', 'success');
    loadDrivers();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── View 4: Driver Profile / Dossier Controller ───────────────────────────
let driverTrendChartInstance = null;
let currentProfileDriverId = null;

async function loadDriverProfile(id) {
  currentProfileDriverId = id;
  try {
    const data = await api(`/api/drivers/${id}`);
    if (!data || !data.driver) return;

    const { driver, stats, trend30d, incidents, trips } = data;

    document.getElementById('profName').textContent = driver.name;
    document.getElementById('profEmpId').textContent = `ID: ${driver.employee_id}`;
    document.getElementById('profVehicle').textContent = `Vehicle: ${driver.vehicle}`;
    document.getElementById('profAvatar').textContent = driver.name.split(' ').map(n=>n[0]).join('');

    const statusEl = document.getElementById('profStatus');
    statusEl.textContent = driver.status;
    statusEl.className = `status-chip ${driver.status}`;

    // Lifetime Stats
    document.getElementById('profTotalTrips').textContent = stats.total_trips;
    document.getElementById('profTotalHours').textContent = (stats.total_seconds / 3600).toFixed(1) + 'h';
    document.getElementById('profMicrosleeps').textContent = stats.total_microsleeps;
    document.getElementById('profAvgPerclos').textContent = (stats.overall_avg_perclos * 100).toFixed(1) + '%';

    // 30-Day Trend Chart
    const ctx = document.getElementById('driverTrendChart').getContext('2d');
    if (driverTrendChartInstance) driverTrendChartInstance.destroy();

    driverTrendChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: trend30d.map(t => t.day.slice(5)),
        datasets: [{
          label: 'Total Incidents',
          data: trend30d.map(t => t.alert_count),
          backgroundColor: '#4F8EF7',
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'JetBrains Mono', size: 10 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(100,116,139,0.1)' } },
        },
      },
    });

    // Trips Table
    document.getElementById('profTripsTableBody').innerHTML = trips.map(t => `
      <tr>
        <td class="num">${new Date(t.start_time).toLocaleDateString()} ${new Date(t.start_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
        <td class="num">${Math.round(t.duration_seconds / 60)} min</td>
        <td class="num">${t.warning_count}</td>
        <td class="num">${t.danger_count}</td>
        <td class="num" style="color: ${t.microsleep_count > 0 ? 'var(--critical)' : 'inherit'}">${t.microsleep_count}</td>
        <td class="num">${(t.avg_perclos * 100).toFixed(1)}%</td>
        <td><span class="risk-badge ${t.risk_level.toLowerCase()}">${t.risk_level} (${t.risk_score})</span></td>
      </tr>
    `).join('') || '<tr><td colspan="7" style="text-align: center;">No trips recorded.</td></tr>';

    // Incidents Table
    document.getElementById('profIncidentsTableBody').innerHTML = incidents.map(inc => `
      <tr>
        <td class="num">${new Date(inc.timestamp).toLocaleTimeString()}</td>
        <td><strong>${inc.type}</strong></td>
        <td><span class="status-chip ${inc.severity === 'critical' ? 'critical' : inc.severity}">${inc.severity}</span></td>
        <td class="num">${inc.duration_ms} ms</td>
        <td class="num">${inc.perclos ? (inc.perclos * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num">${inc.ear ? inc.ear.toFixed(3) : '—'}</td>
        <td>${inc.status}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" style="text-align: center;">No incidents recorded.</td></tr>';

    // Load Incident Snapshots for this driver
    loadDriverSnapshots(id);

  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('backToDriversBtn').addEventListener('click', () => {
  window.location.hash = '#drivers';
});

const downloadProfileReportBtn = document.getElementById('downloadProfileReportBtn');
if (downloadProfileReportBtn) {
  downloadProfileReportBtn.addEventListener('click', () => {
    if (currentProfileDriverId) {
      downloadReport(currentProfileDriverId);
    }
  });
}

// Profile sub-tab switching
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.profile-tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const targetPane = document.getElementById(tab.getAttribute('data-tab'));
    if (targetPane) targetPane.classList.add('active');
  });
});

// ── Snapshots Gallery & Lightbox Controller ───────────────────────────────
const snapshotModal = document.getElementById('snapshotLightboxModal');
const closeLightboxBtn = document.getElementById('closeLightboxBtn');

if (closeLightboxBtn && snapshotModal) {
  closeLightboxBtn.addEventListener('click', () => {
    snapshotModal.classList.remove('active');
  });

  snapshotModal.addEventListener('click', (e) => {
    if (e.target === snapshotModal) {
      snapshotModal.classList.remove('active');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && snapshotModal.classList.contains('active')) {
      snapshotModal.classList.remove('active');
    }
  });
}

function openSnapshotLightbox(snap) {
  if (!snap || !snapshotModal) return;
  const img = document.getElementById('lightboxImg');
  const title = document.getElementById('lightboxTitle');
  const subtitle = document.getElementById('lightboxSubtitle');
  const meta = document.getElementById('lightboxMeta');

  const snapUrl = `/api/snapshots/image/${snap.id}?token=${encodeURIComponent(token)}`;
  img.src = snapUrl;
  img.alt = snap.filename || 'Incident Snapshot';

  title.textContent = `Incident Snapshot #${snap.id}`;
  subtitle.textContent = snap.filename || 'Camera Capture';

  const triggerBadgeClass = snap.trigger_type || 'warning';
  const capturedAt = snap.captured_at ? new Date(snap.captured_at).toLocaleString() : 'Recent';

  meta.innerHTML = `
    <div><strong>Trigger:</strong> <span class="snapshot-badge ${triggerBadgeClass}" style="position: static; margin-left: 6px;">${snap.trigger_type || 'microsleep'}</span></div>
    <div><strong>Captured:</strong> <span class="num" style="margin-left: 6px;">${capturedAt}</span></div>
    <div><strong>Driver ID:</strong> <span class="num" style="margin-left: 6px;">${snap.driver_id}</span></div>
    ${snap.trip_id ? `<div><strong>Trip ID:</strong> <span class="num" style="margin-left: 6px;">#${snap.trip_id}</span></div>` : ''}
    <div style="margin-left: auto;">
      <a href="${snapUrl}" download="${snap.filename || 'snapshot.jpg'}" class="btn btn-secondary btn-sm" style="text-decoration: none;">⬇️ Download Full-Res</a>
    </div>
  `;

  snapshotModal.classList.add('active');
}
window.openSnapshotLightbox = openSnapshotLightbox;

async function loadDriverSnapshots(driverId) {
  const grid = document.getElementById('snapshotsGrid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="snapshot-skeleton"></div>
    <div class="snapshot-skeleton"></div>
    <div class="snapshot-skeleton"></div>
    <div class="snapshot-skeleton"></div>
  `;

  try {
    const data = await api(`/api/snapshots/${encodeURIComponent(driverId)}`);
    const snapshots = (data && data.snapshots) ? data.snapshots : [];

    if (snapshots.length === 0) {
      grid.innerHTML = `
        <div class="snapshots-empty">
          <div style="font-size: 32px; margin-bottom: 8px;">📷</div>
          <div style="font-weight: 600; font-size: 14px; color: var(--text);">No Incident Snapshots</div>
          <div style="color: var(--text-muted); margin-top: 4px;">No camera captures recorded for this driver yet.</div>
        </div>
      `;
      return;
    }

    grid.innerHTML = snapshots.map(snap => {
      const badgeClass = snap.trigger_type || 'warning';
      const timeStr = snap.captured_at ? new Date(snap.captured_at).toLocaleString() : 'Recent';
      return `
        <div class="snapshot-card" data-snap-id="${snap.id}">
          <div class="snapshot-thumb-wrap">
            <span class="snapshot-badge ${badgeClass}">${snap.trigger_type || 'incident'}</span>
            <img class="snapshot-thumb-img" src="/api/snapshots/image/${snap.id}?token=${encodeURIComponent(token)}" alt="${snap.filename}" loading="lazy" />
          </div>
          <div class="snapshot-card-info">
            <div class="snapshot-time">${timeStr}</div>
            <div class="snapshot-filename">${snap.filename}</div>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.snapshot-card').forEach(card => {
      const snapId = parseInt(card.getAttribute('data-snap-id'), 10);
      const snap = snapshots.find(s => s.id === snapId);
      card.addEventListener('click', () => {
        if (snap) openSnapshotLightbox(snap);
      });
    });

  } catch (err) {
    grid.innerHTML = `
      <div class="snapshots-empty">
        <div style="color: var(--critical); font-weight: 600;">Failed to load incident snapshots</div>
        <div style="color: var(--text-muted); margin-top: 4px;">${err.message}</div>
      </div>
    `;
  }
}

const refreshSnapshotsBtn = document.getElementById('refreshSnapshotsBtn');
if (refreshSnapshotsBtn) {
  refreshSnapshotsBtn.addEventListener('click', () => {
    if (currentProfileDriverId) {
      loadDriverSnapshots(currentProfileDriverId);
    }
  });
}

async function viewAlertSnapshot(driverId, employeeId, alertTimestamp, alertType) {
  try {
    const idToQuery = driverId || employeeId;
    if (!idToQuery) {
      showToast('No driver information associated with this alert', 'warning');
      return;
    }
    const data = await api(`/api/snapshots/${encodeURIComponent(idToQuery)}`);
    const snapshots = (data && data.snapshots) ? data.snapshots : [];

    if (snapshots.length === 0) {
      showToast('No camera snapshots available for this driver', 'info');
      return;
    }

    const alertTime = new Date(alertTimestamp).getTime();
    let bestSnap = snapshots[0];
    let minDiff = Infinity;

    for (const snap of snapshots) {
      const snapTime = new Date(snap.captured_at).getTime();
      const diff = Math.abs(snapTime - alertTime);
      if (diff < minDiff) {
        minDiff = diff;
        bestSnap = snap;
      }
    }

    openSnapshotLightbox(bestSnap);
  } catch (err) {
    showToast('Failed to retrieve snapshot: ' + err.message, 'error');
  }
}
window.viewAlertSnapshot = viewAlertSnapshot;

// ── View 5: Alerts Feed Controller ────────────────────────────────────────
async function loadAlertsFeed() {
  const tbody = document.getElementById('alertsFeedTableBody');
  try {
    const data = await api('/api/alerts');
    if (!data || !data.alerts) return;

    if (data.alerts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No alert events recorded.</td></tr>';
      return;
    }

    const isSupervisor = currentUser.role === 'supervisor';

    tbody.innerHTML = data.alerts.slice(0, 50).map(r => `
      <tr>
        <td class="num">${new Date(r.timestamp).toLocaleString()}</td>
        <td><strong>${r.driver_name}</strong> <span class="card-subtitle num">(${r.employee_id})</span></td>
        <td><strong>${r.type}</strong></td>
        <td><span class="status-chip ${r.severity === 'critical' ? 'critical' : r.severity}">${r.severity}</span></td>
        <td class="num">${r.perclos !== null ? (r.perclos * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num">${r.duration_ms} ms</td>
        <td><span class="status-chip ${r.status === 'Acknowledged' ? 'safe' : 'warning'}">${r.status}</span></td>
        <td>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button type="button" class="alert-camera-btn" onclick="viewAlertSnapshot('${r.driver_id}', '${r.employee_id}', '${r.timestamp}', '${r.type}')" title="View Incident Snapshot">📷 Snapshot</button>
            ${r.status === 'New' 
              ? `<button type="button" class="btn btn-secondary btn-sm" onclick="acknowledgeAlert(${r.id})">Acknowledge</button>` 
              : `<span style="font-size: 11px; color: var(--text-muted);">Acknowledged</span>`
            }
            ${!isSupervisor 
              ? `<button type="button" class="btn btn-ghost btn-sm" onclick="deleteAlert(${r.id})" style="color: var(--critical);" title="Delete Alert">🗑️</button>` 
              : ''
            }
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function acknowledgeAlert(alertId) {
  try {
    await api(`/api/alerts/${alertId}/acknowledge`, { method: 'PATCH' });
    showToast('Alert acknowledged successfully', 'success');
    loadAlertsFeed();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.acknowledgeAlert = acknowledgeAlert;

async function deleteAlert(alertId) {
  if (!confirm('Are you sure you want to delete this alert record?')) return;
  try {
    await api(`/api/alerts/${alertId}`, { method: 'DELETE' });
    showToast('Alert record removed', 'info');
    loadAlertsFeed();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteAlert = deleteAlert;

// ── View 6: Reports Controller & CSV Export ───────────────────────────────
let reportsDriverListLoaded = false;
async function populateReportsDriverSelect() {
  if (reportsDriverListLoaded) return;
  const sel = document.getElementById('reportDriverSelect');
  if (!sel) return;
  try {
    const data = await api('/api/drivers');
    if (!data || !data.drivers) return;
    sel.innerHTML = '<option value="">All Fleet Drivers (Consolidated)</option>' +
      data.drivers.map(d => `<option value="${d.id}">${d.name} (${d.employee_id})</option>`).join('');
    reportsDriverListLoaded = true;
  } catch (_) {}
}

async function downloadReport(driverId = '') {
  try {
    const url = driverId ? `/api/reports?format=csv&driver_id=${encodeURIComponent(driverId)}` : '/api/reports?format=csv';
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      if (res.status === 401) {
        showToast('Session expired, please log in again', 'error');
        window.location.replace('/login.html');
        return;
      }
      throw new Error(`Report generation failed (${res.status})`);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    let filename = 'drowsyguard-fleet-report.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];

    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);

    showToast(`Report downloaded: ${filename}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.downloadReport = downloadReport;
window.downloadDriverReport = downloadReport;

async function loadReports() {
  await populateReportsDriverSelect();
  const driverSel = document.getElementById('reportDriverSelect');
  const selectedDriver = driverSel ? driverSel.value : '';
  const tbody = document.getElementById('reportsPreviewBody');

  try {
    const url = selectedDriver ? `/api/reports?driver_id=${encodeURIComponent(selectedDriver)}` : '/api/reports';
    const data = await api(url);
    if (!data || !data.reports) return;

    if (data.reports.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">No trip logs found for this selection.</td></tr>';
      return;
    }

    tbody.innerHTML = data.reports.slice(0, 30).map(r => `
      <tr>
        <td class="num">#${r.trip_id}</td>
        <td>${r.driver_name}</td>
        <td>${r.vehicle}</td>
        <td class="num">${new Date(r.start_time).toLocaleString()}</td>
        <td class="num">${r.duration_minutes}</td>
        <td class="num">${r.warning_count}</td>
        <td class="num" style="color: ${r.microsleep_count > 0 ? 'var(--critical)' : 'inherit'}">${r.microsleep_count}</td>
        <td class="num">${r.risk_score}</td>
        <td><span class="risk-badge ${r.risk_level.toLowerCase()}">${r.risk_level}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

const reportDriverSelect = document.getElementById('reportDriverSelect');
if (reportDriverSelect) {
  reportDriverSelect.addEventListener('change', () => {
    loadReports();
  });
}

const downloadCsvBtn = document.getElementById('downloadCsvBtn');
if (downloadCsvBtn) {
  downloadCsvBtn.addEventListener('click', () => {
    const sel = document.getElementById('reportDriverSelect');
    downloadReport(sel ? sel.value : '');
  });
}

// ── View 7: Settings Controller ───────────────────────────────────────────
async function loadSettings() {
  try {
    const data = await api('/api/settings');
    if (!data || !data.settings) return;

    document.getElementById('settingEar').value = data.settings.earMultiplier || 0.75;
    document.getElementById('settingMar').value = data.settings.marThreshold || 0.60;
    document.getElementById('settingPerclosWarn').value = data.settings.perclosWarningPct || 40;
    document.getElementById('settingMicrosleepFrames').value = data.settings.microsleepFrames || 45;
    document.getElementById('settingEsp32Url').value = data.settings.esp32StreamUrl || '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const earMultiplier = document.getElementById('settingEar').value;
  const marThreshold = document.getElementById('settingMar').value;
  const perclosWarningPct = document.getElementById('settingPerclosWarn').value;
  const microsleepFrames = document.getElementById('settingMicrosleepFrames').value;
  const esp32StreamUrl = document.getElementById('settingEsp32Url').value;

  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ earMultiplier, marThreshold, perclosWarningPct, microsleepFrames, esp32StreamUrl })
    });
    showToast('Fleet settings saved successfully', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Real-Time WebSocket Connection ────────────────────────────────────────
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', role: 'admin' }));
    const badge = document.getElementById('wsConnectionStatus');
    if (badge) {
      badge.textContent = 'WebSocket Live';
      badge.className = 'status-chip safe';
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'microsleep_alert') {
        playAlarmTone();
        showToast(`🚨 CRITICAL: Microsleep detected for ${msg.driverName} (${msg.vehicle})!`, 'error');

        const card = document.getElementById(`liveCard-${msg.driverId}`);
        if (card) {
          card.classList.add('microsleep-alert');
          const chip = card.querySelector('.status-chip');
          if (chip) {
            chip.textContent = 'critical';
            chip.className = 'status-chip critical';
          }
        }
      } else if (msg.type === 'trip_started' || msg.type === 'trip_ended') {
        loadLiveMonitor();
        loadDashboardStats();
        if (msg.type === 'trip_started') {
          showToast(`Driver shift started (#Trip ${msg.tripId})`, 'info');
        }
      } else if (msg.type === 'live_telemetry') {
        const card = document.getElementById(`liveCard-${msg.driverId}`);
        if (card) {
          const perclosEl = document.getElementById(`livePerclos-${msg.driverId}`);
          if (perclosEl && msg.perclos !== undefined) {
            perclosEl.textContent = (msg.perclos * 100).toFixed(1) + '%';
          }
          if (msg.status) {
            const chip = card.querySelector('.status-chip');
            if (chip && chip.textContent !== msg.status) {
              chip.textContent = msg.status;
              chip.className = `status-chip ${msg.status}`;
            }
          }
        } else {
          // If active card doesn't exist yet on Live Monitor, fetch
          const currentHash = window.location.hash || '#dashboard';
          if (currentHash === '#live') {
            loadLiveMonitor();
          }
        }
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    const badge = document.getElementById('wsConnectionStatus');
    if (badge) {
      badge.textContent = 'Disconnected — Reconnecting…';
      badge.className = 'status-chip warning';
    }
    setTimeout(setupWebSocket, 3000);
  };
}

// ── Periodic Real-Time Fleet Sync (every 5 seconds) ────────────────────────
setInterval(() => {
  const hash = window.location.hash || '#dashboard';
  if (hash === '#dashboard') {
    loadDashboardStats();
  } else if (hash === '#live') {
    loadLiveMonitor();
  }
}, 5000);

// ── Boot ──────────────────────────────────────────────────────────────────
setupWebSocket();
navigate();
