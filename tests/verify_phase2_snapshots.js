const http = require('http');
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  { id: 1, email: 'admin@drowsyguard.com', role: 'admin' },
  'drowsyguard-fleet-secure-secret-2026',
  { expiresIn: '1h' }
);

async function testUpload() {
  const boundary = '----SnapshotBoundaryTest9876';
  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9]);
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="driver_id"\r\n\r\nEMP001\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="timestamp"\r\n\r\n1234567\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="trigger"\r\n\r\nmicrosleep\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="snapshot"; filename="snap_1234567.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpegHeader,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  const payload = Buffer.concat(parts);

  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: '/api/snapshots/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.write(payload);
    req.end();
  });
}

async function testGetDriverSnapshots(driverId) {
  return new Promise((resolve) => {
    http.get({
      hostname: 'localhost',
      port: 8080,
      path: `/api/snapshots/${driverId}`,
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
  });
}

async function testGetImage(imageId) {
  return new Promise((resolve) => {
    http.get({
      hostname: 'localhost',
      port: 8080,
      path: `/api/snapshots/image/${imageId}`,
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res) => {
      let len = 0;
      res.on('data', c => len += c.length);
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], bytes: len }));
    });
  });
}

async function testTriggerProxy() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: '/api/snapshots/trigger',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.write(JSON.stringify({ trigger: 'microsleep' }));
    req.end();
  });
}

async function run() {
  console.log('--- 1. Testing POST /api/snapshots/upload ---');
  const uploadRes = await testUpload();
  console.log('Upload:', uploadRes);

  console.log('--- 2. Testing GET /api/snapshots/EMP001 ---');
  const listRes = await testGetDriverSnapshots('EMP001');
  console.log('List:', listRes);

  if (uploadRes.data && uploadRes.data.id) {
    console.log('--- 3. Testing GET /api/snapshots/image/:id ---');
    const imageRes = await testGetImage(uploadRes.data.id);
    console.log('Image:', imageRes);
  }

  console.log('--- 4. Testing POST /api/snapshots/trigger ---');
  const triggerRes = await testTriggerProxy();
  console.log('Trigger:', triggerRes);
}

run();
