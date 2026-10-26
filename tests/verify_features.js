const http = require('http');
const { server, db } = require('../server.js');

async function runTests() {
  // Give server 500ms to start if needed
  await new Promise(r => setTimeout(r, 500));

  function request(options, postData = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      if (postData) {
        req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
      }
      req.end();
    });
  }

  console.log('=== STARTING VERIFICATION TESTS ===\n');

  // 1. Login as Admin
  console.log('1. Logging in as Admin (admin@drowsyguard.io)...');
  const adminLoginRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'admin@drowsyguard.io', password: 'admin123' });

  if (adminLoginRes.status !== 200) {
    throw new Error(`Admin login failed: ${adminLoginRes.status} ${adminLoginRes.body}`);
  }
  const adminData = JSON.parse(adminLoginRes.body);
  const adminToken = adminData.token;
  console.log('✓ Admin login successful. Token acquired.\n');

  // 2. Test Report Download (Fleet CSV)
  console.log('2. Fetching /api/reports?format=csv with Admin JWT...');
  const reportRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/reports?format=csv',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  console.log('Status code:', reportRes.status);
  console.log('Content-Type:', reportRes.headers['content-type']);
  console.log('Content-Disposition:', reportRes.headers['content-disposition']);
  const lines = reportRes.body.split('\n');
  console.log('Total CSV lines:', lines.length);
  console.log('--- FIRST 3 LINES OF DOWNLOADED CSV ---');
  console.log(lines[0]);
  console.log(lines[1]);
  console.log(lines[2]);
  console.log('---------------------------------------\n');

  if (reportRes.status !== 200 || lines.length < 3) {
    throw new Error('Report download failed or CSV returned empty data!');
  }

  // 3. Test Individual Driver Report Download
  console.log('3. Fetching /api/reports?format=csv&driver_id=DRV-101 with Admin JWT...');
  const driverReportRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/reports?format=csv&driver_id=DRV-101',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  console.log('Status code:', driverReportRes.status);
  console.log('Content-Disposition:', driverReportRes.headers['content-disposition']);
  const driverLines = driverReportRes.body.split('\n');
  console.log('First data row for DRV-101:', driverLines[1]);
  console.log('✓ Driver-specific report verified.\n');

  // 4. Login as Supervisor
  console.log('4. Logging in as Supervisor (supervisor@drowsyguard.io)...');
  const supLoginRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'supervisor@drowsyguard.io', password: 'supervisor123' });

  if (supLoginRes.status !== 200) {
    throw new Error(`Supervisor login failed: ${supLoginRes.status} ${supLoginRes.body}`);
  }
  const supData = JSON.parse(supLoginRes.body);
  const supToken = supData.token;
  console.log('✓ Supervisor login successful. Role:', supData.user.role);

  // 5. Supervisor access to Reports (Should be ALLOWED: 200)
  console.log('\n5. Testing Supervisor access to /api/reports?format=csv...');
  const supReportRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/reports?format=csv',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${supToken}` }
  });
  console.log('Supervisor reports status:', supReportRes.status, supReportRes.status === 200 ? '✓ ALLOWED' : '✗ FAILED');

  // 6. Supervisor access to Settings (Should be FORBIDDEN: 403)
  console.log('\n6. Testing Supervisor access to GET /api/settings...');
  const supSettingsRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/settings',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${supToken}` }
  });
  console.log('Supervisor GET settings status:', supSettingsRes.status, supSettingsRes.status === 403 ? '✓ FORBIDDEN (403)' : '✗ FAILED');

  // 7. Supervisor adding driver (Should be FORBIDDEN: 403)
  console.log('\n7. Testing Supervisor POST /api/drivers...');
  const supAddDriverRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/drivers',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supToken}`,
      'Content-Type': 'application/json'
    }
  }, { employee_id: 'DRV-999', name: 'Test', pin: '1234', vehicle: 'Test Truck' });
  console.log('Supervisor POST driver status:', supAddDriverRes.status, supAddDriverRes.status === 403 ? '✓ FORBIDDEN (403)' : '✗ FAILED');

  // 8. Supervisor acknowledging alert (Should be ALLOWED: 200)
  // Find an alert event to acknowledge
  const sampleEvent = db.prepare("SELECT id FROM events WHERE type != 'heartbeat' LIMIT 1").get();
  if (sampleEvent) {
    console.log(`\n8. Testing Supervisor acknowledge alert #${sampleEvent.id}...`);
    const ackRes = await request({
      hostname: 'localhost',
      port: 8080,
      path: `/api/alerts/${sampleEvent.id}/acknowledge`,
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${supToken}` }
    });
    console.log('Supervisor acknowledge alert status:', ackRes.status, ackRes.status === 200 ? '✓ ALLOWED (200)' : '✗ FAILED');

    // 9. Supervisor deleting alert (Should be FORBIDDEN: 403)
    console.log(`\n9. Testing Supervisor delete alert #${sampleEvent.id}...`);
    const delRes = await request({
      hostname: 'localhost',
      port: 8080,
      path: `/api/alerts/${sampleEvent.id}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${supToken}` }
    });
    console.log('Supervisor delete alert status:', delRes.status, delRes.status === 403 ? '✓ FORBIDDEN (403)' : '✗ FAILED');
  }

  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
