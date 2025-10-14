// script.js — frontend logic for index.html
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];
let popupTimeout = null;

function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------- Popup ----------
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.innerHTML = message;

  const iconHTML = success === true
    ? '<div class="popup-icon success">✅</div>'
    : success === false
      ? '<div class="popup-icon error">❌</div>'
      : '';

  popupMessage.innerHTML += iconHTML;

  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = '<button id="popupCloseBtn">Close</button>';

  popupEl.style.display = 'flex';

  const btn = document.getElementById('popupCloseBtn');
  if (btn) btn.onclick = () => (popupEl.style.display = 'none');

  popupTimeout = setTimeout(() => {
    popupEl.style.display = 'none';
  }, 5000);
}

// ---------- Loader ----------
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

// ---------- Fetch office locations ----------
async function fetchLocations() {
  try {
    const r = await fetch('/api/locations');
    const j = await r.json();
    if (!j.success || !Array.isArray(j.locations))
      throw new Error('Invalid response');
    locations = j.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    return true;
  } catch (err) {
    console.error('Error loading locations:', err);
    return false;
  }
}

// ---------- Watch GPS location ----------
async function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  const ok = await fetchLocations();
  if (!ok) return showPopup('Error', 'Unable to load location data.', false);

  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation not supported in this browser.';
    clockInBtn.disabled = clockOutBtn.disabled = true;
    return;
  }

  watchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude } = pos.coords;
    let office = null;
    for (const o of locations) {
      const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (distKm <= o.radiusMeters / 1000) {
        office = o.name;
        break;
      }
    }

    if (office) {
      statusEl.textContent = `You are currently at: ${office}`;
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
    }
  }, err => {
    statusEl.textContent = `Error getting location: ${err.message}`;
    clockInBtn.disabled = clockOutBtn.disabled = true;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

  clockInBtn.addEventListener('click', () => handleClock('clock in'));
  clockOutBtn.addEventListener('click', () => handleClock('clock out'));
}

// ---------- Face recognition ----------
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Camera error: ${err.message}`, false);
    return false;
  }
}
function stopVideo() {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

async function validateFaceWithProxy(base64) {
  try {
    const r = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    const j = await r.json();

    if (j?.result?.length && j.result[0].subjects?.length) {
      const top = j.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) || 0 };
    }
    if (j?.message) return { ok: false, error: j.message };
    return { ok: false, error: 'No face match found' };
  } catch (err) {
    return { ok: false, error: err.message || 'Face API error' };
  }
}

// ---------- Attendance ----------
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  const statusText = document.getElementById('status').textContent;

  if (statusText.includes('Unapproved Location'))
    return showPopup('Unapproved Location', 'You are not at an approved office location.', false);

  if (!lat || !long)
    return showPopup('Location Error', 'Unable to detect GPS coordinates.', false);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  await new Promise(r => setTimeout(r, 1000));
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640;
  tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  showLoader();

  const faceRes = await validateFaceWithProxy(base64);
  if (!faceRes.ok || (faceRes.similarity && faceRes.similarity < 0.55)) {
    hideLoader();
    return showPopup('Verification Unsuccessful', 'Face not recognized.', false);
  }

  try {
    const resp = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: faceRes.subject,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const j = await resp.json();
    hideLoader();

    if (j.success) {
      showPopup('Verification Successful', `Dear ${faceRes.subject}, ${action} successful.`, true);
    } else {
      const msg = j.message?.includes('already')
        ? `Dear ${faceRes.subject}, ${action} denied.`
        : j.message || 'Attendance not logged.';
      showPopup(j.message?.includes('already') ? 'Clock In/Out Denied' : 'Verification Unsuccessful', msg, false);
    }
  } catch (err) {
    hideLoader();
    showPopup('Server Error', `Failed to log attendance: ${err.message}`, false);
  }
}

// ---------- Init ----------
window.onload = startLocationWatch;
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
