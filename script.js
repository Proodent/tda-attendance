// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];
let popupTimeout = null;
let locationErrorShown = false;
let staffCache = new Map(); // Cache UserID → { name, active }

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

// Show popup
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupHeader.className = 'popup-header';
  if (success === true) popupHeader.classList.add('success');
  else if (success === false) popupHeader.classList.add('error');

  popupMessage.innerHTML = message;
  popupMessage.innerHTML += success === true
    ? '<div class="popup-icon success">Success</div>'
    : success === false
      ? '<div class="popup-icon error">Error</div>'
      : '';

  popupFooter.textContent = new Date().toLocaleString('en-US', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  popupRetry.innerHTML = '<button id="popupCloseBtn" class="popup-close-btn">Close</button>';
  popupEl.style.display = 'flex';
  popupEl.classList.add('show');

  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
    if (title === 'Location Error' && success === false) {
      locationErrorShown = true;
    }
  }, 5000);

  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) closeBtn.onclick = () => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
    if (title === 'Location Error' && success === false) {
      locationErrorShown = true;
    }
  };
}

// Show/hide loader
function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}

function hideLoader() {
  if (loaderEl) loaderEl.style.display = "none";
}

// Fetch staff by UserID
async function getStaffByUserId(userId) {
  if (staffCache.has(userId)) return staffCache.get(userId);

  try {
    const res = await fetch('/api/staff-by-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (data.success) {
      staffCache.set(userId, data.staff);
      return data.staff;
    }
    return null;
  } catch (err) {
    console.error('Staff fetch error:', err);
    return null;
  }
}

// Fetch locations
async function fetchLocations() {
  try {
    showLoader("Loading locations...");
    const response = await fetch('/api/locations');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error('Invalid data');
    locations = data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    hideLoader();
    return true;
  } catch (error) {
    hideLoader();
    showPopup('Location Error', `Failed to load locations: ${error.message}`, false);
    return Tanzania;
  }
}

// Start location watch
function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');
  const userIdInput = document.getElementById('userId');

  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  fetchLocations().then(ok => {
    if (!ok) {
      statusEl.textContent = 'Location load failed.';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    if (!navigator.geolocation) {
      showPopup('Geolocation Error', 'Browser does not support geolocation.', false);
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        let office = null;
        for (const loc of locations) {
          const distKm = getDistanceKm(latitude, longitude, loc.lat, loc.long);
          if (distKm <= loc.radiusMeters / 1000) {
            office = loc.name;
            break;
          }
        }
        if (office) {
          statusEl.textContent = `Location: ${office}`;
          locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude;
          locationEl.dataset.long = longitude;
          const userId = userIdInput.value.trim();
          const canClock = userId && staffCache.has(userId);
          clockInBtn.disabled = clockOutBtn.disabled = !canClock;
          locationErrorShown = false;
        } else if (!locationErrorShown) {
          statusEl.textContent = 'Unapproved Location';
          clockInBtn.disabled = clockOutBtn.disabled = true;
          showPopup('Location Error', 'Not at an approved office.', false);
        }
      },
      err => {
        statusEl.textContent = `GPS error: ${err.message}`;
        clockInBtn.disabled = clockOutBtn.disabled = true;
        if (!locationErrorShown) showPopup('Location Error', `GPS failed: ${err.message}`, false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    // Validate UserID on input
    userIdInput.addEventListener('input', async () => {
      const userId = userIdInput.value.trim();
      const buttons = [clockInBtn, clockOutBtn];
      if (!userId) {
        buttons.forEach(b => b.disabled = true);
        return;
      }
      showLoader("Validating User ID...");
      const staff = await getStaffByUserId(userId);
      hideLoader();
      if (staff) {
        if (staff.active.toLowerCase() !== 'yes') {
          showPopup('Access Denied', 'Staff is Inactive.', false);
          buttons.forEach(b => b.disabled = true);
        } else {
          buttons.forEach(b => b.disabled = false);
        }
      } else {
        showPopup('Invalid User ID', 'User ID not found in staff records.', false);
        buttons.forEach(b => b.disabled = true);
      }
    });

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));
  });
}

// Start video
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Access denied: ${err.message}`, false);
    return false;
  }
}

function stopVideo() {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

// Validate face with specific subject
async function validateFaceWithSubject(base64, subjectName) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: subjectName })
    });
    if (!res.ok) return { ok: false, error: 'Face service unavailable' };
    const data = await res.json();
    if (data?.result?.length && data.result[0].subjects?.length) {
      const match = data.result[0].subjects.find(s => s.subject === subjectName);
      if (match) {
        return { ok: true, similarity: match.similarity };
      }
    }
    return { ok: false, error: 'Face not found for this user.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Handle clock
async function handleClock(action) {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Missing User ID', 'Please enter your User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff) return showPopup('Invalid User ID', 'User not found.', false);
  if (staff.active.toLowerCase() !== 'yes') return showPopup('Access Denied', 'Staff is Inactive.', false);

  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'No GPS data.', false);

  let office = null;
  for (const loc of locations) {
    const distKm = getDistanceKm(lat, long, loc.lat, loc.long);
    if (distKm <= loc.radiusMeters / 1000) {
      office = loc.name;
      break;
    }
  }
  if (!office) return showPopup('Location Error', 'Not at an approved office.', false);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  await new Promise(r => setTimeout(r, 1000));
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640; tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';
  showLoader(`Verifying face for ${staff.name}...`);

  const faceRes = await validateFaceWithSubject(base64, staff.name);
  hideLoader();

  if (!faceRes.ok) {
    return showPopup('Face Verification Failed', faceRes.error, false);
  }
  if (faceRes.similarity < 0.7) {
    return showPopup('Face Verification Failed', 'Face similarity too low. Try better lighting.', false);
  }

  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: staff.name,
        userId,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const data = await res.json();
    if (data.success) {
      showPopup('Success', `Dear ${staff.name}, ${action} recorded at ${office}.`, true);
    } else {
      showPopup('Attendance Error', data.message, false);
    }
  } catch (err) {
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}

// Admin login (unchanged)
async function fetchAdminLogins() { /* ... */ }
function loginAdmin() { /* ... */ }

// Init
document.addEventListener('DOMContentLoaded', () => {
  startLocationWatch();
  const adminDashboardBtn = document.getElementById('adminDashboard');
  if (adminDashboardBtn) {
    adminDashboardBtn.addEventListener('click', () => {
      document.getElementById('adminPopup').classList.add('show');
    });
  }
});

window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
