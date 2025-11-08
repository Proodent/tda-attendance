let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage;
let faceLoaderEl, userIdInput, userIdFeedback;
let staffCache = new Map();
let isVerifyingFace = false;

// Utility
function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Show Popup
function showPopup(title, message, isSuccess) {
  popupHeader.textContent = title;
  popupHeader.className = 'popup-header ' + (isSuccess ? 'success' : 'error');
  popupMessage.textContent = message;
  popupEl.style.display = 'flex';
  popupEl.classList.add('show');

  setTimeout(() => {
    popupEl.classList.remove('show');
    setTimeout(() => { popupEl.style.display = 'none'; }, 300);
  }, 5000);
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
  } catch { return null; }
}

// Fetch locations
async function fetchLocations() {
  try {
    const res = await fetch('/api/locations');
    const data = await res.json();
    return data.success ? data.locations : [];
  } catch { return []; }
}

// Start location + UserID validation
function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');
  userIdInput = document.getElementById('userId');
  userIdFeedback = document.getElementById('userIdFeedback');
  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  faceLoaderEl = document.getElementById('faceLoader');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');

  fetchLocations().then(locations => {
    if (!locations.length) {
      statusEl.textContent = 'Location load failed.';
      return;
    }

    if (!navigator.geolocation) return showPopup('Error', 'Geolocation not supported.', false);

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

        locationEl.dataset.lat = latitude;
        locationEl.dataset.long = longitude;
        locationEl.textContent = `Location: ${office || 'Unapproved'}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

        statusEl.textContent = office || 'Unapproved Location';
        const canClock = userIdInput.value.trim() && staffCache.has(userIdInput.value.trim()) && staffCache.get(userIdInput.value.trim()).active === 'yes';
        clockInBtn.disabled = clockOutBtn.disabled = !canClock || !office;
      },
      () => statusEl.textContent = 'GPS error',
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    // UserID input handler
    userIdInput.addEventListener('input', async () => {
      const userId = userIdInput.value.trim();
      clockInBtn.disabled = clockOutBtn.disabled = true;
      userIdFeedback.textContent = 'Validating...';
      userIdFeedback.className = '';

      if (!userId) {
        userIdFeedback.textContent = '';
        return;
      }

      const staff = await getStaffByUserId(userId);
      if (staff && staff.active === 'yes') {
        userIdFeedback.textContent = `User ${userId} found: ${staff.name}`;
        userIdFeedback.className = 'valid';
        const hasLocation = locationEl.textContent.includes('Location: ') && !locationEl.textContent.includes('Unapproved');
        clockInBtn.disabled = clockOutBtn.disabled = !hasLocation;
      } else {
        userIdFeedback.textContent = `User ${userId} not found`;
        userIdFeedback.className = 'invalid';
      }
    });

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));
  });
}

// Face verification
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch {
    showPopup('Camera Error', 'Camera access denied.', false);
    return false;
  }
}

function stopVideo() {
  if (videoEl?.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

async function validateFaceWithSubject(base64, subjectName) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: subjectName })
    });
    const data = await res.json();

    if (!data?.result?.[0]?.subjects?.length) {
      return { ok: false, error: 'Face not found' };
    }

    const match = data.result[0].subjects.find(s => s.subject === subjectName);
    if (!match) return { ok: false, error: "Face doesn't match" };
    if (match.similarity < 0.7) return { ok: false, error: 'Face similarity too low' };

    return { ok: true, similarity: match.similarity };
  } catch {
    return { ok: false, error: 'Face service error' };
  }
}

// Handle clock
async function handleClock(action) {
  if (isVerifyingFace) return;
  const userId = userIdInput.value.trim();
  if (!userId) return showPopup('Error', 'Enter User ID.', false);

  const staff = staffCache.get(userId);
  if (!staff) return showPopup('Error', 'Invalid User ID.', false);

  const lat = Number(document.getElementById('location').dataset.lat);
  const long = Number(document.getElementById('location').dataset.long);
  if (!lat || !long) return showPopup('Error', 'No GPS.', false);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  isVerifyingFace = true;
  faceLoaderEl.style.display = 'block';

  await new Promise(r => setTimeout(r, 1200));
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640; tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  faceLoaderEl.style.display = 'none';

  const faceRes = await validateFaceWithSubject(base64, staff.name);
  isVerifyingFace = false;
  document.getElementById('faceRecognition').style.display = 'none';

  if (!faceRes.ok) {
    return showPopup('Face Verification Failed', faceRes.error, false);
  }

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
  showPopup(data.success ? 'Success' : 'Error', data.message, data.success);
}

// Admin Login
document.getElementById('adminDashboard')?.addEventListener('click', () => {
  document.getElementById('adminPopup').classList.add('show');
});

document.getElementById('adminLoginBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value.trim();
  const errorEl = document.getElementById('adminError');

  if (!email || !password) {
    errorEl.textContent = 'Fill both fields.';
    return;
  }

  errorEl.textContent = 'Logging in...';
  const res = await fetch('/api/admin-logins');
  const data = await res.json();

  if (data.success && data.logins.some(l => l[0] === email && l[1] === password)) {
    localStorage.setItem('isLoggedIn', 'true');
    window.location.href = '/stats.html';
  } else {
    errorEl.textContent = 'Invalid credentials.';
  }
});

// Init
document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
