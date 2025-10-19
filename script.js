// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];
let popupTimeout = null;

// Utility functions
function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Show popup with success/error icon and auto-close after 5 seconds
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupHeader.className = 'popup-header'; // Reset classes
  if (success === true) {
    popupHeader.classList.add('success');
  } else if (success === false) {
    popupHeader.classList.add('error');
  }

  popupMessage.innerHTML = message;
  popupMessage.innerHTML += success === true
    ? '<div class="popup-icon success">✅</div>'
    : success === false
      ? '<div class="popup-icon error">❌</div>'
      : '';

  popupFooter.textContent = new Date().toLocaleString('en-US', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  popupRetry.innerHTML = '<button id="popupCloseBtn" class="popup-close-btn">Close</button>';
  popupEl.style.display = 'flex';
  popupEl.classList.add('show');

  // Auto-close after 5 seconds
  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  }, 5000);

  // Close button handler
  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) {
    closeBtn.onclick = () => {
      popupEl.classList.remove('show');
      popupEl.style.display = 'none';
    };
  }
}

// Show loader during async operations
function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}

// Hide loader
function hideLoader() {
  if (loaderEl) loaderEl.style.display = "none";
}

// Fetch office locations from server
async function fetchLocations() {
  try {
    const r = await fetch('/api/locations');
    const j = await r.json();
    if (!j.success || !Array.isArray(j.locations)) throw new Error('Bad locations response');
    locations = j.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    console.log('Loaded locations:', locations);
    return true;
  } catch (err) {
    console.error('Error loading locations:', err);
    showPopup('Location Error', 'Unable to load location data. Please check your connection.', false);
    return false;
  }
}

// Start location monitoring
async function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  const ok = await fetchLocations();
  if (!ok) return;

  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation not supported in this browser.';
    clockInBtn.disabled = clockOutBtn.disabled = true;
    showPopup('Geolocation Error', 'Geolocation is not supported in this browser.', false);
    return;
  }

  watchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude } = pos.coords;
    let office = null;
    for (const o of locations) {
      const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (distKm <= (o.radiusMeters / 1000)) {
        office = o.name;
        break;
      }
    }

    if (office) {
      statusEl.textContent = `You are currently at: ${office}`;
      locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      locationEl.dataset.lat = latitude;
      locationEl.dataset.long = longitude;
      clockInBtn.disabled = clockOutBtn.disabled = false;
      clockInBtn.style.opacity = clockOutBtn.style.opacity = "1";
    } else {
      statusEl.textContent = 'Unapproved Location';
      locationEl.textContent = `Location: Unapproved\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      locationEl.dataset.lat = latitude;
      locationEl.dataset.long = longitude;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      clockInBtn.style.opacity = clockOutBtn.style.opacity = "0.6";
      showPopup('Location Error', 'You are not at an approved office location.', false);
    }
  }, err => {
    statusEl.textContent = `Error getting location: ${err.message}`;
    clockInBtn.disabled = clockOutBtn.disabled = true;
    showPopup('Location Error', `Unable to detect GPS coordinates: ${err.message}`, false);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

  document.getElementById('clockIn').addEventListener('click', () => handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('clock out'));

  // Admin Dashboard button handler
  document.getElementById('adminDashboard').addEventListener('click', () => {
    document.getElementById('adminPopup').classList.add('show');
    document.getElementById('adminError').textContent = "";
    document.getElementById('adminEmail').value = "";
    document.getElementById('adminPassword').value = "";
  });
}

// Start video for facial recognition
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Camera access denied: ${err.message}`, false);
    return false;
  }
}

// Stop video stream
function stopVideo() {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

// Validate face via CompreFace proxy
async function validateFaceWithProxy(base64) {
  try {
    const r = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    if (!r.ok) {
      return { ok: false, error: 'Face recognition service unavailable' };
    }
    const j = await r.json();
    console.log('Face proxy returned:', j);

    if (j?.result?.length && j.result[0].subjects?.length) {
      const top = j.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) || 0 };
    }
    return { ok: false, error: j?.message || 'No matching face found' };
  } catch (err) {
    console.error('validateFaceWithProxy error', err);
    return { ok: false, error: err.message || 'Face recognition service error' };
  }
}

// Handle clock in/out
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) {
    return showPopup('Location Error', 'Unable to detect GPS coordinates.', false);
  }

  // Verify office location
  let office = null;
  for (const o of locations) {
    const distKm = getDistanceKm(lat, long, o.lat, o.long);
    if (distKm <= (o.radiusMeters / 1000)) {
      office = o.name;
      break;
    }
  }
  if (!office) {
    return showPopup('Location Error', 'You are not at an approved office location.', false);
  }

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  await new Promise(r => setTimeout(r, 1000)); // Delay for face capture

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640;
  tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  showLoader(`${action === 'clock in' ? 'Clocking In' : 'Clocking Out'}...`);

  const faceRes = await validateFaceWithProxy(base64);
  if (!faceRes.ok) {
    hideLoader();
    return showPopup('Face Recognition Error', faceRes.error || 'No matching face found.', false');
  }
  if (faceRes.similarity < 0.85) {
    hideLoader();
    return showPopup('Face Recognition Error', 'Face similarity too low. Please try again with better lighting.', false);
  }

  try {
    const resp = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: faceRes.subject,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const j = await resp.json();
    hideLoader();

    if (j.success) {
      showPopup('Verification Successful', `Dear ${faceRes.subject}, ${action} recorded at ${office}.`, true);
    } else {
      const errorMessages = {
        'Staff not found or inactive': `Dear ${faceRes.subject}, your profile is not found or inactive. Please contact HR.`,
        'Not inside any registered office location': 'You are not at an approved office location.',
        'Unapproved Location': `Dear ${faceRes.subject}, you are not authorized to clock in/out at this location.`,
        'Dear': `Dear ${faceRes.subject}, ${j.message.toLowerCase()}`,
        'Invalid input': 'Invalid request data. Please try again.'
      };
      const message = errorMessages[j.message] || j.message || 'Attendance not logged.';
      showPopup('Attendance Error', message, false);
    }
  } catch (err) {
    hideLoader();
    console.error('Attendance API error', err);
    showPopup('Server Error', `Failed to connect to server: ${err.message}`, false);
  }
}

// Fetch admin logins from Google Sheet
async function fetchAdminLogins() {
  // Note: SHEET_ID and API_KEY should be loaded from environment variables via a server or build tool
  const SHEET_ID = process.env.SHEET_ID || '1hGuj1yAy2zB1n8xQq_soIq8lMl_TYmz6x0KgTNtjP2A'; // Fallback for local testing
  const API_KEY = process.env.API_KEY || 'AIzaSyCTFfZAlX_eKUU3UY6mQknUUQyUWZiRLKw'; // Fallback for local testing
  if (!SHEET_ID || !API_KEY) {
    console.error('SHEET_ID or API_KEY not set');
    return [];
  }
  const range = "Admin Logins!A2:B"; // Targeting the Admin Logins tab
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error! Status: ${res.status} - ${res.statusText}`);
    const data = await res.json();
    console.log("Fetched admin logins data:", data);
    if (!data.values || data.values.length === 0) {
      console.warn("No values found in the Admin Logins tab.");
      return [];
    }
    return data.values;
  } catch (error) {
    console.error("Error fetching admin logins:", error);
    return [];
  }
}

// Handle admin login
async function loginAdmin() {
  const email = document.getElementById("adminEmail").value.trim();
  const password = document.getElementById("adminPassword").value.trim();
  const adminError = document.getElementById("adminError");
  const adminPopup = document.getElementById("adminPopup");

  if (!email || !password) {
    adminError.textContent = "Please fill in both fields.";
    return;
  }

  const adminLogins = await fetchAdminLogins();
  if (adminLogins.length === 0) {
    adminError.textContent = "No admin logins found. Check the 'Admin Logins' tab in your Google Sheet.";
    return;
  }

  const validLogin = adminLogins.find(row => row[0] === email && row[1] === password);
  console.log("Checking login:", { email, password, adminLogins });

  if (validLogin) {
    adminPopup.classList.remove("show");
    window.location.href = "stats.html";
  } else {
    adminError.textContent = "Invalid email or password.";
  }
}

// Close admin popup if clicked outside
document.getElementById("adminPopup").addEventListener("click", (e) => {
  if (e.target === document.getElementById("adminPopup")) {
    document.getElementById("adminPopup").classList.remove("show");
  }
});

window.onload = startLocationWatch;
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
