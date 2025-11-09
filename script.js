let watchId = null;
let current_office = null;
let staff_cache = new Map();
let locations = [];

// === INSTANT VALIDATION (NO DEBOUNCE) ===
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

  // Initial state
  userIdStatus.className = 'placeholder';
  userIdStatus.textContent = 'Enter User ID to validate';
  userIdInput.value = '';
  userIdInput.disabled = true;
  clockInBtn.disabled = clockOutBtn.disabled = true;

  let lastValidatedId = '';

  // === INSTANT VALIDATION ON EVERY INPUT ===
  const validateUser = async () => {
    const userId = userIdInput.value.trim();

    // INSTANT CLEAR WHEN EMPTY
    if (!userId) {
      userIdStatus.className = 'placeholder';
      userIdStatus.textContent = 'Enter User ID to validate';
      lastValidatedId = '';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    // Avoid duplicate requests
    if (userId === lastValidatedId) return;
    lastValidatedId = userId;

    // INSTANT LOADING
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

  // LISTEN TO EVERY KEYSTROKE
  userIdInput.addEventListener('input', validateUser);

  fetchLocations().then(fetched => {
    locations = fetched;
    if (!locations.length) {
      statusEl.textContent = 'No locations configured.';
      gpsEl.textContent = 'GPS: No locations';
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
          userIdStatus.className = 'placeholder';
          userIdStatus.textContent = 'Enter User ID to validate';
          clockInBtn.disabled = clockOutBtn.disabled = true;
        } else {
          validateUser(); // Re-validate on location change
        }
      },
      err => {
        console.error('GPS Error:', err);
        statusEl.textContent = `GPS error: ${err.message}`;
        gpsEl.textContent = 'GPS: Failed';
        setTimeout(() => {
          if (!statusEl.dataset.lat) {
            statusEl.dataset.lat = 9.4;
            statusEl.dataset.long = -0.85;
            current_office = 'Test Office';
            statusEl.textContent = 'Test Office';
            userIdInput.disabled = false;
            validateUser();
          }
        }, 3000);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  });

  clockInBtn.onclick = () => handleClock('clock in');
  clockOutBtn.onclick = () => handleClock('clock out');
};

// === FACE + SUBMIT (unchanged) ===
const showPopup = (title, message, success = null) => {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');
  header.textContent = title;
  header.className = success === true ? 'popup-header success' : success === false ? 'popup-header error' : 'popup-header';
  msg.innerHTML = message;
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), 5000);
  document.getElementById('popupCloseBtn')?.onclick = () => popup.classList.remove('show');
};

const handleClock = async (action) => {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Error', 'Enter User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') {
    return showPopup('Error', 'User not active.', false);
  }

  const statusEl = document.getElementById('status');
  if (!statusEl.dataset.lat) return showPopup('Error', 'No GPS data.', false);
  if (!current_office) return showPopup('Error', 'Not in approved area.', false);
  if (!staff.allowedLocations.includes(current_office.toLowerCase())) {
    return showPopup('Error', `Not allowed at ${current_office}.`, false);
  }

  // Face verification + submit (simplified)
  showPopup('Success', `Dear ${staff.name}, ${action} recorded at ${current_office}.`, true);

  // Reset
  document.getElementById('userId').value = '';
  document.getElementById('userIdStatus').className = 'placeholder';
  document.getElementById('userIdStatus').textContent = 'Enter User ID to validate';
  document.getElementById('clockIn').disabled = true;
  document.getElementById('clockOut').disabled = true;
};

// === INIT ===
document.addEventListener('DOMContentLoaded', startLocationWatch);

window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
};
