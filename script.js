let watchId = null;
let current_office = null;
let staff_cache = new Map();
let videoEl, faceModal, captureStatus;
let countdown = 0;
let countdownInterval = null;
let locations = [];

const toRad = v => v * Math.PI / 180;
const getDistanceKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getStaffByUserId = async (userId) => {
  if (staff_cache.has(userId)) return staff_cache.get(userId);
  try {
    const res = await fetch('/api/staff-by-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (data.success) {
      const allowed = (data.staff.allowedLocations || []).map(l => l.toLowerCase());
      const staff = { ...data.staff, allowedLocations: allowed };
      staff_cache.set(userId, staff);
      return staff;
    }
  } catch (err) {
    console.error('Staff fetch error:', err);
  }
  return null;
};

const fetchLocations = async () => {
  try {
    const res = await fetch('/api/locations');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error('Invalid response');
    return data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
  } catch (err) {
    showPopup('Location Error', `Failed to load locations: ${err.message}`, false);
    return [];
  }
};

const startLocationWatch = () => {
  const statusEl = document.getElementById('status');
  const gpsEl = document.getElementById('gpsCoords');
  const locEl = document.getElementById('location');
  const userIdInput = document.getElementById('userId');
  const userIdStatus = document.getElementById('userIdStatus');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  // Reset
  userIdStatus.classList.remove('show');
  userIdStatus.style.display = 'none';
  userIdInput.value = '';
  userIdInput.disabled = true;
  clockInBtn.disabled = clockOutBtn.disabled = true;

  let lastValidatedId = '';

  const validateUser = async () => {
    const userId = userIdInput.value.trim();

    // Hide if empty
    if (!userId) {
      userIdStatus.classList.remove('show');
      userIdStatus.style.display = 'none';
      lastValidatedId = '';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    if (userId === lastValidatedId) return;
    lastValidatedId = userId;

    // Force show
    userIdStatus.style.display = 'flex';
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

    if (staff.active.toLowerCase() !== 'yes') {
      userIdStatus.className = 'inactive';
      userIdStatus.textContent = `User ${userId}: ${staff.name} is Inactive`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    const approved = current_office && staff.allowedLocations.includes(current_office.toLowerCase());
    userIdStatus.className = approved ? 'valid' : 'invalid';
    userIdStatus.textContent = `User ${userId}: ${staff.name} – ${approved ? 'Approved' : 'Not Approved'}`;
    clockInBtn.disabled = clockOutBtn.disabled = !approved;
  };

  // Attach input listener
  userIdInput.addEventListener('input', validateUser);

  // GPS Watch
  fetchLocations().then(fetched => {
    locations = fetched;
    if (!locations.length) {
      statusEl.textContent = 'No locations configured.';
      return;
    }

    if (!navigator.geolocation) {
      showPopup('GPS Error', 'Geolocation not supported.', false);
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        locEl.dataset.lat = latitude;
        locEl.dataset.long = longitude;
        gpsEl.textContent = `GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

        current_office = null;
        for (const loc of locations) {
          const dist = getDistanceKm(latitude, longitude, loc.lat, loc.long);
          if (dist <= loc.radiusMeters / 1000) {
            current_office = loc.name;
            break;
          }
        }

        statusEl.textContent = current_office || 'Outside approved area';
        userIdInput.disabled = !current_office;

        if (!current_office) {
          userIdInput.value = '';
          userIdStatus.classList.remove('show');
          userIdStatus.style.display = 'none';
          clockInBtn.disabled = clockOutBtn.disabled = true;
        } else if (userIdInput.value.trim()) {
          validateUser();
        }
      },
      err => {
        console.error('GPS Error:', err);
        statusEl.textContent = `GPS error: ${err.message}`;
        gpsEl.textContent = 'GPS: Failed';
        setTimeout(() => {
          if (!locEl.dataset.lat) {
            locEl.dataset.lat = 9.4;
            locEl.dataset.long = -0.85;
            gpsEl.textContent = 'GPS: Test Mode (9.4, -0.85)';
            current_office = 'Test Office';
            statusEl.textContent = 'Test Office';
            userIdInput.disabled = false;
            if (userIdInput.value.trim()) validateUser();
          }
        }, 3000);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  });

  clockInBtn.onclick = () => handleClock('clock in');
  clockOutBtn.onclick = () => handleClock('clock out');
};

// === ADMIN POPUP – X + CLICK OUTSIDE ===
const adminPopup = document.getElementById('adminPopup');
const adminCloseBtn = document.getElementById('adminCloseBtn');

document.getElementById('adminDashboard')?.addEventListener('click', () => {
  adminPopup.classList.add('show');
});

adminCloseBtn?.addEventListener('click', () => {
  adminPopup.classList.remove('show');
});

adminPopup?.addEventListener('click', (e) => {
  if (e.target === adminPopup) {
    adminPopup.classList.remove('show');
  }
});

// === REST OF script.js (unchanged) ===
const validateFaceWithSubject = async (base64, subjectName) => {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: subjectName })
    });
    if (!res.ok) return { ok: false, error: 'Face service unavailable' };
    const data = await res.json();
    if (data?.result?.[0]?.subjects?.length) {
      const match = data.result[0].subjects.find(s => s.subject === subjectName);
      if (match && match.similarity >= 0.7) return { ok: true, similarity: match.similarity };
    }
    return { ok: false, error: 'Face not recognized' };
  } catch (err) {
    return { ok: false, error: 'Face service error' };
  }
};

const showFaceModal = async (staff, action) => {
  faceModal = document.getElementById('faceModal');
  videoEl = document.getElementById('video');
  captureStatus = document.getElementById('captureStatus');
  faceModal.classList.add('show');

  if (!await startVideo()) {
    hideFaceModal();
    return;
  }

  countdown = 3;
  captureStatus.textContent = `Capturing in ${countdown}...`;
  countdownInterval = setInterval(async () => {
    countdown--;
    if (countdown > 0) {
      captureStatus.textContent = `Capturing in ${countdown}...`;
    } else {
      clearInterval(countdownInterval);
      captureStatus.textContent = 'Verifying...';
      await captureAndVerify(staff, action);
    }
  }, 1000);
};

const hideFaceModal = () => {
  if (faceModal) faceModal.classList.remove('show');
  if (countdownInterval) clearInterval(countdownInterval);
  stopVideo();
};

const startVideo = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Access denied: ${err.message}`, false);
    return false;
  }
};

const stopVideo = () => {
  if (videoEl?.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
};

const captureAndVerify = async (staff, action) => {
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

  const result = await validateFaceWithSubject(base64, staff.name);
  hideLoader();

  if (!result.ok) {
    showPopup('Face Verification Failed', result.error, false);
    return;
  }

  await submitAttendance(action, staff);
};

const submitAttendance = async (action, staff) => {
  const locEl = document.getElementById('location');
  const lat = Number(locEl.dataset.lat);
  const long = Number(locEl.dataset.long);

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
    showPopup(
      data.success ? 'Success' : 'Error',
      data.success
        ? `Dear ${staff.name}, ${action} recorded at ${current_office}.`
        : data.message || 'Attendance failed.',
      data.success
    );
  } catch (err) {
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
};

const showPopup = (title, message, success = null) => {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');
  header.textContent = title;
  header.className = success === true ? 'popup-header success' : success === false ? 'popup-header error' : 'popup-header';
  msg.innerHTML = message;
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), 5000);
  document.getElementById('popupCloseBtn').onclick = () => popup.classList.remove('show');
};

const showLoader = (text) => {
  const loader = document.getElementById('loaderOverlay');
  loader.querySelector('p').textContent = text;
  loader.style.display = 'flex';
};

const hideLoader = () => {
  document.getElementById('loaderOverlay').style.display = 'none';
};

const handleClock = async (action) => {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Error', 'Enter User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') {
    return showPopup('Error', 'User not active.', false);
  }

  const locEl = document.getElementById('location');
  if (!locEl.dataset.lat) return showPopup('Error', 'No GPS data.', false);
  if (!current_office) return showPopup('Error', 'Not in approved area.', false);
  if (!staff.allowedLocations.includes(current_office.toLowerCase())) {
    return showPopup('Error', `Not allowed at ${current_office}.`, false);
  }

  showFaceModal(staff, action);
};

// === ADMIN LOGIN ===
document.getElementById('adminLoginBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('adminEmail')?.value.trim();
  const password = document.getElementById('adminPassword')?.value.trim();
  const error = document.getElementById('adminError');
  const btn = document.getElementById('adminLoginBtn');

  if (!email || !password) {
    error.textContent = 'Fill both fields.';
    return;
  }

  btn.classList.add('loading');
  btn.disabled = true;
  error.textContent = '';

  try {
    const res = await fetch('/api/admin-logins');
    const data = await res.json();
    if (data.success && data.logins.some(r => r[0] === email && r[1] === password)) {
      localStorage.setItem('isLoggedIn', 'true');
      window.location.href = 'stats.html';
    } else {
      error.textContent = 'Invalid credentials.';
    }
  } catch {
    error.textContent = 'Login failed.';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

// === INIT ===
document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
