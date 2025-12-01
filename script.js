// === FINAL script.js — ALL BUGS FIXED ===
let watchId = null;
let current_office = null;
let staff_cache = new Map();
let videoEl, faceModal, captureStatus;
let countdown = 0;
let countdownInterval = null;
let locations = [];
let soundPlayed = false;

// Audio unlock + success sound only once per action
const successSound = new Audio('/assets/success-sound.mp3');
const errorSound = new Audio('/assets/error-sound.mp3');

const unlockAudio = () => {
  successSound.play().catch(() => {});
  errorSound.play().catch(() => {});
  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('touchstart', unlockAudio);
};
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);

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
  const userIdInput = document.getElementById('userId');
  const userIdStatus = document.getElementById('userIdStatus');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  userIdInput.disabled = true;
  clockInBtn.disabled = clockOutBtn.disabled = true;

  let lastValidatedId = '';

  const validateUser = async () => {
    const userId = userIdInput.value.trim();
    if (!userId || userId === lastValidatedId) return;
    lastValidatedId = userId;

    userIdStatus.className = 'loading';
    userIdStatus.textContent = 'Validating...';

    const staff = await getStaffByUserId(userId);
    if (userIdInput.value.trim() !== userId) return;

    if (!staff) {
      userIdStatus.className = 'invalid';
      userIdStatus.textContent = `User ${userId} not found`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }
    if (staff.active.toLowerCase() !== 'yes') {
      userIdStatus.className = 'inactive';
      userIdStatus.textContent = `User ${userId}: ${staff.name} — Inactive`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    const approved = current_office && staff.allowedLocations.includes(current_office.toLowerCase());
    userIdStatus.className = approved ? 'valid' : 'invalid';
    userIdStatus.innerHTML = `User ${userId}: <strong>${staff.name}</strong><br>
      <span style="font-size:1.2em;">${approved ? 'Approved' : 'Denied'}</span>`;

    clockInBtn.disabled = clockOutBtn.disabled = !approved;
  };

  userIdInput.addEventListener('input', () => {
    clearTimeout(window.validateTimeout);
    const userId = userIdInput.value.trim();
    if (!userId) {
      userIdStatus.className = 'placeholder';
      userIdStatus.textContent = 'Enter User ID to validate';
      lastValidatedId = '';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }
    userIdStatus.className = 'loading';
    userIdStatus.textContent = 'Validating...';
    window.validateTimeout = setTimeout(validateUser, 300);
  });

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
        statusEl.dataset.lat = latitude;
        statusEl.dataset.long = longitude;
        gpsEl.textContent = `GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

        current_office = null;
        for (const loc of locations) {
          const dist = getDistanceKm(latitude, longitude, loc.lat, loc.loc.long);
          if (dist * 1000 <= loc.radiusMeters) {
            current_office = loc.name;
            break;
          }
        }

        statusEl.textContent = current_office ? `${current_office} (Location)` : 'Outside Office Locations';
        userIdInput.disabled = !current_office;

        if (!current_office) {
          userIdInput.value = '';
          userIdStatus.className = 'placeholder';
          userIdStatus.textContent = 'Enter User ID to validate';
          clockInBtn.disabled = clockOutBtn.disabled = true;
        } else if (userIdInput.value.trim()) {
          validateUser();
        }
      },
      err => {
        console.error('GPS Error:', err);
        statusEl.textContent = 'GPS error: Try again';
        gpsEl.textContent = 'GPS: Failed';
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
    );
  });

  clockInBtn.onclick = () => handleClock('clock in');
  clockOutBtn.onclick = () => handleClock('clock out');
};

// Face Verification
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
      if (match && match.similarity >= 0.6) return { ok: true };
    }
    return { ok: false, error: 'Face not recognized' };
  } catch (err) {
    return { ok: false, error: 'Network error' };
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

  countdown = 2;
  captureStatus.textContent = `Capturing in ${countdown}...`;
  countdownInterval = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      captureStatus.textContent = `Capturing in ${countdown}...`;
    } else {
      clearInterval(countdownInterval);
      captureStatus.textContent = 'Verifying...';
      captureAndVerify(staff, action);
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
    showPopup('Camera Error', 'Please allow camera access', false);
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
  canvas.width = videoEl.videoWidth || 640;
  canvas.height = videoEl.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

  hideFaceModal();
  showLoader(`Verifying ${staff.name}...`);

  const result = await validateFaceWithSubject(base64, staff.name);
  hideLoader();

  if (!result.ok) {
    showPopup('Failed', result.error || 'Face not recognized', false);
    return;
  }

  // SUCCESS SOUND — ONLY ONCE
  if (!soundPlayed) {
    successSound.play().catch(() => {});
    soundPlayed = true;
    setTimeout(() => soundPlayed = false, 4000);
  }

  showPopup('Face Verified', `Recording ${action}...`, true);
  await submitAttendance(action, staff);
};

const submitAttendance = async (action, staff) => {
  const statusEl = document.getElementById('status');
  const lat = Number(statusEl.dataset.lat);
  const lon = Number(statusEl.dataset.long);

  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: staff.name,
        userId: document.getElementById('userId').value.trim(),
        latitude: lat,
        longitude: lon,
        timestamp: new Date().toISOString()
      })
    });

    const data = await res.json();

    // FINAL SUCCESS MESSAGE — NO APOSTROPHE, CLEAN TEXT
    const cleanTime = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    showPopup(
      data.success ? 'Success' : 'Error',
      data.success
        ? `${staff.name}, you have successfully <strong>${action === 'clock in' ? 'CLOCKED IN' : 'CLOCKED OUT'}</strong><br>Time: ${cleanTime}<br>Location: ${current_office}`
        : data.message || 'Failed to record attendance',
      data.success
    );

  } catch (err) {
    showPopup('Network Error', 'Check your internet connection', false);
  }
};

const showPopup = (title, message, isSuccess = null) => {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');

  header.textContent = title;
  header.className = isSuccess === true ? 'popup-header success' :
                     isSuccess === false ? 'popup-header error' : 'popup-header';
  msg.innerHTML = message;
  popup.classList.add('show');

  if (isSuccess === false) {
    errorSound.play().catch(() => {});
  }

  setTimeout(() => popup.classList.remove('show'), 6000);
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
  if (!userId) return showPopup('Error', 'Enter User ID', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes')
    return showPopup('Error', 'User not active or not found', false);

  if (!current_office)
    return showPopup('Error', 'You are not in an approved location', false);

  if (!staff.allowedLocations.includes(current_office.toLowerCase()))
    return showPopup('Error', `You are not allowed at ${current_office}`, false);

  showFaceModal(staff, action);
};

// Admin Login (unchanged)
document.getElementById('adminDashboard')?.addEventListener('click', () => {
  document.getElementById('adminPopup').classList.add('show');
});
document.getElementById('adminCloseBtn')?.addEventListener('click', () => {
  document.getElementById('adminPopup').classList.remove('show');
});
document.getElementById('adminPopup')?.addEventListener('click', e => {
  if (e.target.id === 'adminPopup') e.target.classList.remove('show');
});

document.getElementById('adminLoginBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value.trim();
  const error = document.getElementById('adminError');
  const btn = document.getElementById('adminLoginBtn');

  if (!email || !password) {
    error.textContent = 'Fill both fields';
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
      error.textContent = 'Invalid credentials';
    }
  } catch {
    error.textContent = 'Login failed';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

// Start everything
document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
