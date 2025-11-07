// ---------------------------------------------------------------
// index.js  (root)
// ---------------------------------------------------------------
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Google Sheet ----------
const SHEET_ID = "1hGuj1yAy2zB1n8xQq_soIq8lMl_TYmz6x0KgTNtjP2A";
const CREDS_PATH = path.join(__dirname, 'service-account.json');
const doc = new GoogleSpreadsheet(SHEET_ID);
let docLoaded = false;

async function loadDoc() {
  if (docLoaded) return;
  try {
    await doc.useServiceAccountAuth(require(CREDS_PATH));
    await doc.loadInfo();
    docLoaded = true;
    console.log('Google Sheet loaded:', doc.title);
  } catch (e) {
    console.error('loadDoc error:', e.message);
    throw e;
  }
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));   // <-- serve EVERY file in root

// ---------- Helpers ----------
const formatDate = d => d.toISOString().split('T')[0];
const formatTime = d => d.toTimeString().slice(0, 8);

function getLocationFromIP(ip) {
  const map = { '127.0.0.1': 'Head Office', '::1': 'Head Office' };
  return map[ip] || 'Unknown';
}

// ---------- ROUTES ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---- Staff list ----
app.get('/api/staff', async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle['Staff Sheet'];
    if (!sheet) return res.status(500).json({ error: 'Staff Sheet missing' });

    const rows = await sheet.getRows();
    const active = rows
      .filter(r => (r.Active || '').toString().trim().toLowerCase() === 'yes')
      .map(r => ({
        userId: (r.UserID || '').toString().trim(),
        name: (r.Name || '').trim(),
        department: (r.Department || '').trim(),
        allowedLocations: (r['Allowed Locations'] || '')
          .split(',')
          .map(l => l.trim())
          .filter(Boolean)
      }));

    res.json({
      totalStaff: rows.length,
      staffCount: active.length,
      staff: active
    });
  } catch (e) {
    console.error('/api/staff error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- Staff by UserID ----
app.get('/api/staff/:id', async (req, res) => {
  const id = req.params.id.trim();
  if (!/^\d{3}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'UserID must be 3 digits' });
  }

  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle['Staff Sheet'];
    if (!sheet) return res.status(500).json({ success: false, error: 'Staff Sheet missing' });

    const rows = await sheet.getRows();
    const staff = rows.find(r => {
      try {
        const uid = (r.UserID || '').toString().trim();
        const act = (r.Active || '').toString().trim().toLowerCase();
        return uid === id && act === 'yes';
      } catch { return false; }
    });

    if (!staff) {
      return res.json({ success: false, error: 'UserID not found or inactive' });
    }

    res.json({
      success: true,
      name: (staff.Name || '').trim(),
      userId: (staff.UserID || '').toString().trim(),
      department: (staff.Department || '').trim(),
      allowedLocations: (staff['Allowed Locations'] || '')
        .split(',')
        .map(l => l.trim())
        .filter(Boolean),
      comprefaceSubject: (staff.Name || '').trim()
    });
  } catch (e) {
    console.error('/api/staff/:id error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- Daily stats ----
app.get('/api/stats', async (req, res) => {
  const date = req.query.date || formatDate(new Date());
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle['Attendance Sheet'];
    if (!sheet) return res.status(500).json({ error: 'Attendance Sheet missing' });

    const rows = await sheet.getRows();
    const today = rows.filter(r => (r.Date || '').trim() === date);

    const staffAttendance = today.map(r => ({
      userId: (r.UserID || '').toString().trim(),
      name: (r.Name || '').trim(),
      department: (r.Department || '').trim(),
      timeIn: (r['Time In'] || '').trim(),
      timeOut: (r['Time Out'] || '').trim(),
      clockInLocation: (r['Clock In Location'] || '').trim() || 'Unknown'
    }));

    res.json({ staffAttendance });
  } catch (e) {
    console.error('/api/stats error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- Locations list ----
app.get('/api/locations', async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle['Staff Sheet'];
    if (!sheet) return res.status(500).json({ error: 'Staff Sheet missing' });

    const rows = await sheet.getRows();
    const set = new Set();
    rows.forEach(r => {
      (r['Allowed Locations'] || '')
        .split(',')
        .map(l => l.trim())
        .filter(Boolean)
        .forEach(l => set.add(l));
    });

    res.json({ locations: Array.from(set).map(name => ({ name })) });
  } catch (e) {
    console.error('/api/locations error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- Clock-In ----
app.post('/api/clockin', async (req, res) => {
  const { userId, image } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const location = getLocationFromIP(ip);

  if (!userId || !image) {
    return res.status(400).json({ success: false, error: 'Missing userId or image' });
  }

  try {
    // 1. CompreFace recognition
    const compRes = await fetch('http://localhost:8080/api/v1/recognition/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const comp = await compRes.json();
    const subject = comp.result?.[0]?.subjects?.[0]?.subject;

    // 2. Validate staff
    const staffRes = await fetch(`${req.protocol}://${req.get('host')}/api/staff/${userId}`);
    const staff = await staffRes.json();

    if (!staff.success || staff.comprefaceSubject !== subject) {
      return res.json({ success: false, error: 'Face mismatch or invalid UserID' });
    }
    if (!staff.allowedLocations.includes(location)) {
      return res.json({ success: false, error: 'Location not allowed' });
    }

    // 3. Record
    await loadDoc();
    const sheet = doc.sheetsByTitle['Attendance Sheet'];
    await sheet.addRow({
      Date: formatDate(new Date()),
      UserID: userId,
      Name: staff.name,
      Department: staff.department,
      'Time In': formatTime(new Date()),
      'Time Out': '',
      'Clock In Location': location
    });

    res.json({ success: true, message: 'Clock-in recorded' });
  } catch (e) {
    console.error('clockin error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---- Clock-Out ----
app.post('/api/clockout', async (req, res) => {
  const { userId, image } = req.body;
  if (!userId || !image) {
    return res.status(400).json({ success: false, error: 'Missing userId or image' });
  }

  try {
    const compRes = await fetch('http://localhost:8080/api/v1/recognition/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const comp = await compRes.json();
    const subject = comp.result?.[0]?.subjects?.[0]?.subject;

    const staffRes = await fetch(`${req.protocol}://${req.get('host')}/api/staff/${userId}`);
    const staff = await staffRes.json();

    if (!staff.success || staff.comprefaceSubject !== subject) {
      return res.json({ success: false, error: 'Face mismatch' });
    }

    await loadDoc();
    const sheet = doc.sheetsByTitle['Attendance Sheet'];
    const rows = await sheet.getRows();
    const today = formatDate(new Date());
    const row = rows.find(r =>
      (r.Date || '').trim() === today &&
      (r.UserID || '').toString().trim() === userId &&
      !(r['Time Out'] || '').trim()
    );

    if (!row) return res.json({ success: false, error: 'No clock-in found' });

    row['Time Out'] = formatTime(new Date());
    await row.save();

    res.json({ success: true, message: 'Clock-out recorded' });
  } catch (e) {
    console.error('clockout error:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
  console.log(`Dashboard → http://localhost:${PORT}/stats.html`);
});
