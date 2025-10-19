// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];

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
  popupHeader.className = 'popup-header';
  if (success === true) popupHeader.classList.add('success');
  else if (success === false) popupHeader.classList.add('error');

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

  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  }, 5000);

  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) closeBtn.onclick = () => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  };
}

// Show loader during async operations
function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  } else {
    console.error("Loader overlay not found");
  }
}

// Hide loader
function hideLoader() {
  if (loaderEl) loaderEl.style.display = "none";
}

// Fetch office locations from server
async function fetchLocations() {
  try {
    showLoader("Loading locations...");
    console.log('Fetching /api/locations...');
    const response = await fetch('/api/locations', { mode: 'cors' });
    console.log('Response status:', response.status);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
    const data = await response.json();
    console.log('Raw data:', data);
    if (!data.success || !Array.isArray(data.locations)) throw new Error('Invalid location data format: ' + JSON.stringify(data));
    locations = data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    console.log('Loaded locations:', locations);
    hideLoader();
    return true;
  } catch (error) {
    console.error('Location fetch error:', error);
    hideLoader();
    showPopup('Location Error', `Failed to load locations: ${error.message}. Check server and Locations Sheet.`, false);
    return false;
  }
}

// Start location monitoring
function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  if (!statusEl || !locationEl || !clockInBtn || !clockOutBtn) {
    console.error('Missing DOM elements:', { statusEl, locationEl, clockInBtn, clockOutBtn });
    showPopup('Init Error', 'Required elements not found. Reload the page.', false);
    return;
  }

  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  fetchLocations().then(ok => {
    console.log('fetchLocations result:', ok);
    if (!ok) return;

    if (!navigator.geolocation) {
      statusEl.textContent = 'Geolocation not supported.';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      showPopup('Geolocation Error', 'Your browser doesn’t support geolocation.', false);
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
          statusEl.textContent = `At: ${office}`;
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
          showPopup('Location Error', 'Not at an approved office.', false);
        }
      },
      err => {
        statusEl.textContent = `Location error: ${err.message}`;
        clockInBtn.disabled = clockOutBtn.disabled = true;
        showPopup('Location Error', `GPS failed: ${err.message}`, false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));

    const adminDashboardBtn = document.getElementById('adminDashboard');
    if (adminDashboardBtn) {
      adminDashboardBtn.addEventListener('click', () => {
        console.log('Admin Dashboard clicked');
        const adminPopup = document.getElementById('adminPopup');
        if (adminPopup) {
          adminPopup.classList.add('show');
          document.getElementById('adminError').textContent = "";
          document.getElementById('adminEmail').value = "";
          document.getElementById('adminPassword').value = "";
        } else {
          console.error('Admin popup missing');
          showPopup('Init Error', 'Admin popup not found.', false);
        }
      });
    } else {
      console.error('Admin button missing');
      showPopup('Init Error', 'Admin Dashboard button not found.', false);
    }
  });
}

// Start video for facial recognition
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream
