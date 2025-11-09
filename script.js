let watchId = null;
let currentOffice = null;
let staffCache = new Map();
let videoEl, faceModal, captureStatus;
let countdown = 0;
let countdownInterval = null;

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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error('Invalid data');
    return data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
  } catch (error) {
    showPopup('Location Error', `Failed to load locations: ${error.message}`, false);
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

  // === INPUT LISTENERS – ALWAYS ACTIVE ===
  const validateAndShow = () => {
    const value = userIdInput.value.trim();
    if (value) {
      userIdStatus.classList.add('show');  // ALWAYS SHOW IF TEXT EXISTS
    } else {
      userIdStatus.classList.remove('show');
    }
    updateUserStatus();
  };

  ['input', 'keydown', 'keyup', 'paste', 'change'].forEach(event => {
    userIdInput.addEventListener(event, validateAndShow);
  });
  userIdInput.addEventListener('focus', validateAndShow);

  // Initialize
  userIdStatus.dataset.lastUserId = '';
  userIdInput.disabled = true;
  userIdInput.placeholder = 'Outside approved area';
  userIdStatus.classList.remove('show');
  statusEl.textContent = 'Loading locations...';
  gpsEl.textContent = 'GPS: Acquiring...';
  gpsEl.dataset.lat = '';
  gpsEl.dataset.long = '';

  fetchLocations().then(locations => {
    if (locations.length === 0) {
      statusEl.textContent = 'No office locations configured.';
      gpsEl.textContent = 'GPS: N/A';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    statusEl.textContent = 'Waiting for GPS signal...';

    if (!navigator.geolocation) {
      showPopup('Geolocation Error', 'Your browser does not support GPS.', false);
      statusEl.textContent = 'GPS not supported';
      gpsEl.textContent = 'GPS: Disabled';
      return;
    }

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

        if (currentOffice && userIdInput.disabled) {
          userIdInput.disabled = false;
          userIdInput.placeholder = 'Enter User ID';
          userIdInput.focus();
        } else if (!currentOffice && !userIdInput.disabled) {
          userIdInput.disabled = true;
          userIdInput.value = '';
          userIdInput.placeholder = 'Outside approved area';
          userIdStatus.classList.remove('show');
          clockInBtn.disabled = clockOutBtn.disabled = true;
        }

        // Revalidate only if input has text
        if (userIdInput.value.trim()) {
          updateUserStatus();
        }
      },
      err => {
        console.error('GPS Error:', err);
        let msg = 'GPS error';
        if (err.code === 1) msg = 'Location access denied';
        if (err.code === 2) msg = 'Location unavailable';
        if (err.code === 3) msg = 'GPS timeout';
        statusEl.textContent = msg;
        gpsEl.textContent = 'GPS: Failed';
        clockInBtn.disabled = clockOutBtn.disabled = true;
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  });

  // === PERSISTENT VALIDATION – NEVER HIDES UNTIL INPUT IS EMPTY ===
  async function updateUserStatus() {
    const userId = userIdInput.value.trim();
    const currentLastId = userIdStatus.dataset.lastUserId;

    // Only revalidate if UserID changed
    if (currentLastId === userId) return;

    userIdStatus.dataset.lastUserId = userId;

    if (!userId) {
      userIdStatus.className = 'loading';
      userIdStatus.textContent = 'Enter User ID...';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    // Always show box during validation
    userIdStatus.classList.add('show');
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

  clockInBtn.addEventListener('click', () => handleClock('clock in'));
  clockOutBtn.addEventListener('click', () => handleClock('clock out'));
}

// === FACE VERIFICATION ===
async function validateFaceWithSubject(base64, subjectName) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: subjectName })
    });
    if (!res.ok) return { ok: false, error: 'Face service unavailable' };

    const data = await res.json();
    if (!data?.result?.length || !data.result[0].subjects?.length) {
      return { ok: false, error: 'Face not added' };
    }

    const match = data.result[0].subjects.find(s => s.subject === subjectName);
    if (!match) return { ok: false, error: 'Face not added' };
    if (match.similarity < 0.7) return { ok: false, error: 'Face mismatch' };

    return { ok: true, similarity: match.similarity };
  } catch (err) {
    return { ok: false, error: 'Face service error' };
  }
}

// === FACE MODAL ===
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
