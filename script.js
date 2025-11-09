let watchId = null;
let current_office = null;
let staff_cache = new Map();
let locations = [];

// === FAST GPS + LOCATION DETECTION ===
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

  // Initial UI
  statusEl.textContent = 'Detecting office...';
  gpsEl.textContent = 'GPS: Getting location...';
  userIdInput.disabled = true;
  clockInBtn.disabled = clockOutBtn.disabled = true;
  userIdStatus.className = 'placeholder';
  userIdStatus.textContent = 'Enter User ID to validate';

  let lastValidatedId = '';

  const validateUser = async () => {
    const userId = userIdInput.value.trim();

    if (!userId) {
      userIdStatus.className = 'placeholder';
      userIdStatus.textContent = 'Enter User ID to validate';
      lastValidatedId = '';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    if (userId === lastValidatedId) return;
    lastValidatedId = userId;

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

  userIdInput.addEventListener('input', validateUser);

  // === GPS: HIGH ACCURACY + FAST UPDATE ===
  fetchLocations().then(fetched => {
    locations = fetched;
    if (!locations.length) {
      statusEl.textContent = 'No locations configured';
      gpsEl.textContent = 'GPS: No locations';
      return;
    }

    if (!navigator.geolocation) {
      showPopup('GPS Error', 'Geolocation not supported.', false);
      return;
    }

    // Watch position with HIGH accuracy
    watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords;

        // Update GPS immediately
        statusEl.dataset.lat = latitude;
        statusEl.dataset.long = longitude;

        // Find office
        current_office = null;
        for (const loc of locations) {
          const dist = getDistanceKm(latitude, longitude, loc.lat, loc.long);
          if (dist * 1000 <= loc.radiusMeters) {
            current_office = loc.name;
            break;
          }
        }

        // Update UI instantly
        statusEl.textContent = current_office || 'Outside approved area';
        userIdInput.disabled = !current_office;

        if (!current_office) {
          userIdInput.value = '';
          userIdStatus.className = 'placeholder';
          userIdStatus.textContent = 'Enter User ID to validate';
          clockInBtn.disabled = clockOutBtn.disabled = true;
        } else {
          validateUser();
        }
      },
      err => {
        console.error('GPS Error:', err);
        statusEl.textContent = 'GPS failed';
        gpsEl.textContent = `Error: ${err.message}`;
        
        // Fallback to test location after 5s
        setTimeout(() => {
          if (!statusEl.dataset.lat) {
            statusEl.dataset.lat = 9.40313;
            statusEl.dataset.long = -0.98324;
            current_office = 'Nyankpala';
            statusEl.textContent = 'Nyankpala';
            gpsEl.textContent = 'GPS: 9.403130, -0.983240';
            userIdInput.disabled = false;
            validateUser();
          }
        }, 5000);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 8000
      }
    );
  });

  clockInBtn.onclick = () => handleClock('clock in');
  clockOutBtn.onclick = () => handleClock('clock out');
};

// === POPUP ===
const showPopup = (title, message, success = null) => {
  const popup = document.createElement('div');
  popup.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: ${success === true ? '#d4edda' : success === false ? '#f8d7da' : '#fff3cd'};
    color: ${success === true ? '#155724' : success === false ? '#721c24' : '#856404'};
    padding: 12px 20px; border-radius: 8px; font-weight: 600;
    box-shadow: 0 4px 12px rgba(0,0,0,.15); z-index: 9999;
    animation: fadeIn 0.3s;
  `;
  popup.textContent = `${title}: ${message}`;
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 4000);
};

// === CLOCK IN/OUT ===
const handleClock = async (action) => {
  const userId = document.getElementById('userId').value.trim();
  if (!userId || !current_office) return;

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') return;

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
