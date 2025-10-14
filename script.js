// script.js
let watchId = null;
let popupEl, popupHeader, popupMessage, popupFooter, popupRetry, loaderEl;
let locations = [];
let popupTimeout = null;

function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showPopup(title, message, success = null, retry = false) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.innerHTML = message;

  // Add proper icons
  popupMessage.innerHTML += success === true
    ? '<div class="popup-icon success">✔</div>'
    : success === false
      ? '<div class="popup-icon error">✖</div>'
      : '';

  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = retry ? '<button id="popupRetryBtn">Retry</button>' : '';
  popupEl.classList.add('show');

  if (retry) {
    const btn = document.getElementById('popupRetryBtn');
    if (btn) btn.onclick = () => window.location.reload();
  }

  popupTimeout = setTimeout(() => popupEl.classList.remove('show'), 5000);
}

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

async function fetchLocations() {
  try {
    const r = await fetch('/api/locations');
    const j = await r.json();
    if (!j.success || !Array.isArray(j.locations)) throw new Error('Bad locations response');
    locations = j.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    return true;
  } catch {
    return false;
  }
}

async function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  const ok = await fetchLocations();
  if (!ok) return showPopup('Error', 'Unable to load office locations.', false, true);

  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation not supported.';
    clockInBtn.disabled = clockOutBtn.disabled = true;
    return;
  }

  watchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude } = pos.coords;
    let office = null;
    for (const o of locations) {
      const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (distKm <= (o.radiusMeters / 1000)) { office = o.name; break; }
    }

    if (office) {
      statusEl.textContent = `You are currently at: ${office}`;
      locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      locationEl.dataset.lat = latitude;
      locationEl.dataset.long = longitude;
      clockInBtn.disabled = clockOutBtn.disabled = false;
    } else {
      statusEl.textContent = 'Unapproved Location';
      locationEl.textContent = `Location: Unapproved\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      clockInBtn.disabled = clockOutBtn.disabled = true;
    }
  }, err => {
    statusEl.textContent = `Error: ${err.message}`;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

  document.getElementById('clockIn').addEventListener('click', () => handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('clock out'));
}

async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'Unable to detect location.', false, true);

  showLoader("Verifying Face...");

  // Simulated face recognition and API call
  await new Promise(r => setTimeout(r, 1500)); // simulate delay
  hideLoader();

  // Simulate API response
  const random = Math.random();
  if (random < 0.3) return showPopup('Verification Unsuccessful', 'Face not recognized.', false, true);
  if (random < 0.6) return showPopup('Clock In Denied', 'You have already clocked in today.', false);
  if (random < 0.8) return showPopup('Unapproved Location', 'You are not at an approved office.', false);

  showPopup('Verification Successful', `Dear Staff, ${action} successful.`, true);
}

window.onload = startLocationWatch;
window.onunload = () => { if (watchId) navigator.geolocation.clearWatch(watchId); };
