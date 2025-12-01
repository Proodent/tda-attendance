let watchId = null;
let current_office = null;
let staff_cache = new Map();
let videoEl, faceModal, captureStatus;
let countdown = 0;
let countdownInterval = null;
let locations = [];

// Sound unlock + play only once
const successSound = new Audio('/assets/success-sound.mp3');
const errorSound = new Audio('/assets/error-sound.mp3');
let soundPlayed = false;

const unlockAudio = () => {
  if (soundPlayed) return;
  successSound.load(); errorSound.load();
  const silent = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
  silent.play().catch(() => {});
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
  } catch (err) { console.error('Staff fetch error:', err); }
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

  userIdStatus.className = 'placeholder';
  userIdStatus.textContent = 'Enter User ID to validate';
  userIdInput.value = '';
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
      userIdStatus.textContent = `User ${userId}: ${staff.name} - Inactive`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }
    const approved = current_office && staff.allowedLocations.includes(current_office.toLowerCase());
    userIdStatus.className = approved ? 'valid' : 'invalid';
    userIdStatus.textContent = `User ${userId}: ${staff.name} – ${approved ? 'Approved' : 'Denied'}`;
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
          const dist = getDistanceKm(latitude, longitude, loc.lat, loc.long);
          if (dist * 1000 <= loc.radiusMeters) {
            current_office = loc.name;
            break;
          }
        }
        statusEl.textContent = current_office ? `${current_office}` : 'Outside approved area';
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
        statusEl.textContent = 'GPS error';
        gpsEl.textContent = 'GPS: Failed';
        // TEST MODE fallback
        setTimeout(() => {
          if (!statusEl.dataset.lat) {
            statusEl.dataset.lat = 9.4321;
            statusEl.dataset.long = -0.8456;
            gpsEl.textContent = 'GPS: Test Mode (9.4321, -0.8456)';
            current_office = 'Tolon Office';
            statusEl.textContent = `${current_office}`;
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

// Face & attendance functions (your code – unchanged & perfect)
const validateFaceWithSubject = async (base64, subjectName) => { /* ... your code ... */ };
const showFaceModal = async (staff, action) => { /* ... your code ... */ };
const hideFaceModal = () => { /* ... your code ... */ };
const startVideo = async () => { /* ... your code ... */ };
const stopVideo = () => { /* ... your code ... */ };
const captureAndVerify = async (staff, action) => { /* ... your code ... */ };
const submitAttendance = async (action, staff) => { /* ... your code ... */ };

const showPopup = (title, message, success = null) => {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');
  header.textContent = title;
  header.className = success === true ? 'popup-header success' : success === false ? 'popup-header error' : 'popup-header';
  msg.innerHTML = message;
  popup.classList.add('show');
  if (success === true && !soundPlayed) {
    successSound.play().catch(() => {});
    soundPlayed = true;
    setTimeout(() => soundPlayed = false, 3000);
  } else if (success === false) {
    errorSound.play().catch(() => {});
  }
  setTimeout(() => popup.classList.remove('show'), 5000);
  document.getElementById('popupCloseBtn').onclick = () => popup.classList.remove('show');
};

const showLoader = text => {
  const loader = document.getElementById('loaderOverlay');
  loader.querySelector('p').textContent = text;
  loader.style.display = 'flex';
};
const hideLoader = () => document.getElementById('loaderOverlay').style.display = 'none';

const handleClock = async (action) => { /* ... your code ... */ };

document.getElementById('adminDashboard')?.addEventListener('click', () => document.getElementById('adminPopup').classList.add('show'));
document.getElementById('adminCloseBtn')?.addEventListener('click', () => document.getElementById('adminPopup').classList.remove('show'));
document.getElementById('adminPopup')?.addEventListener('click', e => e.target.id === 'adminPopup' && e.target.classList.remove('show'));

document.getElementById('adminLoginBtn')?.addEventListener('click', async () => { /* ... your admin login ... */ });

document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
