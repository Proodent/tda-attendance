let watchId = null;
let currentOffice = null;
let staffCache = new Map();
let videoEl, faceModal, captureStatus;
let countdown = 0;
let countdownInterval = null;
let locations = [];

// === UTILITY ===
function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// === FETCH STAFF ===
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
      const allowed = data.staff.allowedLocations || [];
      staffCache.set(userId, { ...data.staff, allowedLocations: allowed });
      return staffCache.get(userId);
    }
    return null;
  } catch (err) {
    console.error('Staff fetch error:', err);
    return null;
  }
}

// === FETCH LOCATIONS ===
async function fetchLocations() {
  try {
    const response = await fetch('/api/locations');
    if (!response.ok) return [];
    const data = await response.json();
    if (!data.success) return [];
    return data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
  } catch (error) {
    console.error('Locations error:', error);
    return [];
  }
}

// === START GPS WATCH ===
function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const gpsEl = document.getElementById('gpsCoords');
  const userIdInput = document.getElementById('userId');
  const userIdStatus = document.getElementById('userIdStatus');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  // === VALIDATION BOX ALWAYS VISIBLE ===
  userIdStatus.classList.add('show');
  userIdStatus.textContent = 'Enter User ID...';
  userIdStatus.className = 'loading';

  // === SINGLE INPUT LISTENER ===
  userIdInput.addEventListener('input', () => {
    const userId = userIdInput.value.trim();
    if (!userId) {
      userIdStatus.className = 'loading';
      userIdStatus.textContent = 'Enter User ID...';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }
    validateUser(userId);
  });

  // === VALIDATE USER ===
  async function validateUser(userId) {
    userIdStatus.className = 'loading';
    userIdStatus.textContent = 'Validating...';

    const staff = await getStaffByUserId(userId);
    if (!staff) {
      userIdStatus.className = 'invalid';
      userIdStatus.textContent = `User ${userId} not found`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    const isActive = staff.active.toLowerCase() === 'yes';
    const isApproved = currentOffice && staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase());

    const activeText = isActive ? 'Active' : 'Inactive';
    const approvalText = isApproved ? 'Approved' : 'Not Approved';

    userIdStatus.className = isActive && isApproved ? 'valid' : 'invalid';
    userIdStatus.textContent = `User ${userId} : ${staff.name} – ${activeText} – ${approvalText}`;

    clockInBtn.disabled = clockOutBtn.disabled = !(isActive && isApproved);
  }

  // Initialize
  userIdInput.disabled = true;
  userIdInput.placeholder = 'Outside approved area';
  statusEl.textContent = 'Loading GPS...';
  gpsEl.textContent = 'GPS: Starting...';

  // === FETCH LOCATIONS ===
  fetchLocations().then(locs => {
    locations = locs;
  });

  // === GPS – FAST & FALLBACK ===
  if (!navigator.geolocation) {
    statusEl.textContent = 'GPS not supported';
    gpsEl.textContent = 'GPS: Off';
    return;
  }

  // Try real GPS
  watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      gpsEl.dataset.lat = latitude;
      gpsEl.dataset.long = longitude;
      gpsEl.textContent = `GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

      currentOffice = null;
      for (const loc of locations) {
        const distKm = getDistanceKm(latitude, longitude, loc.lat, loc.long);
        if (distKm <= loc.radiusMeters / 1000) {
          currentOffice = loc.name;
          break;
        }
      }

      statusEl.textContent = currentOffice || 'Outside approved area';

      if (currentOffice) {
        userIdInput.disabled = false;
        userIdInput.placeholder = 'Enter User ID';
        userIdInput.focus();
        clockInBtn.disabled = clockOutBtn.disabled = true; // Wait for valid ID
      } else {
        userIdInput.disabled = true;
        userIdInput.value = '';
        userIdInput.placeholder = 'Outside approved area';
        userIdStatus.textContent = 'Outside approved area';
        userIdStatus.className = 'invalid';
        clockInBtn.disabled = clockOutBtn.disabled = true;
      }

      // Revalidate if ID exists
      if (userIdInput.value.trim()) {
        validateUser(userIdInput.value.trim());
      }
    },
    () => {
      // Fallback after 3s
      setTimeout(() => {
        if (!gpsEl.dataset.lat) {
          gpsEl.dataset.lat = 9.4;
          gpsEl.dataset.long = -0.85;
          gpsEl.textContent = 'GPS: Test (9.4, -0.85)';
          currentOffice = 'Test Office';
          statusEl.textContent = 'Test Office';
          userIdInput.disabled = false;
          userIdInput.placeholder = 'Enter User ID';
          userIdInput.focus();
          userIdStatus.textContent = 'Enter User ID...';
          userIdStatus.className = 'loading';
        }
      }, 3000);
    },
    { enableHighAccuracy: false, maximumAge: 5000, timeout: 8000 }
  );

  // === CLOCK BUTTONS ===
  clockInBtn.onclick = () => handleClock('clock in');
  clockOutBtn.onclick = () => handleClock('clock out');
}

// === FACE VERIFICATION (unchanged) ===
async function validateFaceWithSubject(base64, subjectName) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: subjectName })
    });
    if (!res.ok) return { ok: false, error: 'Face service unavailable' };
    const data = await res.json();
    if (!data?.result?.length || !data.result[0].subjects?.length) return { ok: false, error: 'Face not added' };
    const match = data.result[0].subjects.find(s => s.subject === subjectName);
    if (!match) return { ok: false, error: 'Face not added' };
    if (match.similarity < 0.7) return { ok: false, error: 'Face mismatch' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Face service error' };
  }
}

// === FACE MODAL (unchanged) ===
async function showFaceModal(staff, action) {
  faceModal = document.getElementById('faceModal');
  videoEl = document.getElementById('video');
  captureStatus = document.getElementById('captureStatus');
  faceModal.classList.add('show');
  const started = await startVideo();
  if (!started) { hideFaceModal(); return; }

  countdown = 3;
  captureStatus.textContent = `Capturing in ${countdown}...`;
  countdownInterval = setInterval(async () => {
    countdown--;
    if (countdown > 0) {
      captureStatus.textContent = `Capturing in ${countdown}...`;
    } else {
      clearInterval(countdownInterval);
      captureStatus.textContent = "Verifying...";
      await captureAndVerify(staff, action);
    }
  }, 1000);
}

function hideFaceModal() {
  if (faceModal) faceModal.classList.remove('show');
  if (countdownInterval) clearInterval(countdownInterval);
  stopVideo();
}

async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
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

async function captureAndVerify(staff, action) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  hideFaceModal();
  showLoader(`Verifying face for ${staff.name}...`);

  try {
    const faceRes = await validateFaceWithSubject(base64, staff.name);
    hideLoader();
    if (!faceRes.ok) {
      showPopup('Face Verification Failed', faceRes.error, false);
      return;
    }
    await submitAttendance(action, staff);
  } catch (err) {
    hideLoader();
    showPopup('Face Error', `Verification failed: ${err.message}`, false);
  }
}

async function submitAttendance(action, staff) {
  const gpsEl = document.getElementById('gpsCoords');
  const lat = Number(gpsEl.dataset.lat);
  const long = Number(gpsEl.dataset.long);

  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: staff.name,
        userId: document.getElementById('userId').value.trim(),
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const data = await res.json();
    if (data.success) {
      showPopup('Success', `Dear ${staff.name}, ${action} recorded at ${currentOffice}.`, true);
    } else {
      showPopup('Attendance Error', data.message, false);
    }
  } catch (err) {
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}

function showPopup(title, message, success = null) {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');
  header.textContent = title;
  header.className = success === true ? 'popup-header success' : success === false ? 'popup-header error' : 'popup-header';
  msg.innerHTML = message;
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), 5000);
  document.getElementById('popupCloseBtn').onclick = () => popup.classList.remove('show');
}

function showLoader(text) {
  const loader = document.getElementById('loaderOverlay');
  loader.querySelector('p').textContent = text;
  loader.style.display = 'flex';
}

function hideLoader() {
  document.getElementById('loaderOverlay').style.display = 'none';
}

async function handleClock(action) {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Missing User ID', 'Please enter your User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') {
    return showPopup('Invalid User ID', 'User not found or inactive.', false);
  }

  const gpsEl = document.getElementById('gpsCoords');
  const lat = Number(gpsEl.dataset.lat);
  const long = Number(gpsEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'No GPS data.', false);

  if (!currentOffice) return showPopup('Location Error', 'Not at an approved office.', false);
  if (!staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase())) {
    return showPopup('Location Denied', `You are not allowed at ${currentOffice}.`, false);
  }

  showFaceModal(staff, action);
}

// Admin Dashboard
document.getElementById('adminDashboard').addEventListener('click', () => {
  document.getElementById('adminPopup').classList.add('show');
});

// === INITIALIZE ===
document.addEventListener('DOMContentLoaded', () => {
  startLocationWatch();
});

// === CLEANUP ===
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
