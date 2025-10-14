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
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showPopup(title, message, success = null, retry = false) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.innerHTML = message;

  // Add success/error icon
  popupMessage.innerHTML += success === true
    ? '<div class="popup-icon success">✔️</div>'
    : success === false
      ? '<div class="popup-icon error">❌</div>'
      : '';

  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = retry ? '<button id="popupRetryBtn">Retry</button>' : '';
  popupEl.classList.add('show');
  popupEl.style.display = "flex";

  if (retry) {
    const btn = document.getElementById('popupRetryBtn');
    if (btn) btn.onclick = () => window.location.reload();
  }

  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  }, 5000);
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
    if (!j.success || !Array.isArray(j.locations)) throw new Error('Invalid location data.');
    locations = j.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    console.log('Loaded locations:', locations);
    return true;
  } catch (err) {
    console.error('Error loading locations:', err);
    showPopup('Connection Error', 'Failed to fetch approved locations. Please check your internet connection and try again.', false, true);
    return false;
  }
}

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
  if (!ok) return;

  if (!navigator.geolocation) {
    statusEl.textContent = 'Your browser does not support GPS location.';
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
      statusEl.textContent = `You are within ${office}`;
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
    statusEl.textContent = `Unable to get location: ${err.message}`;
    clockInBtn.disabled = clockOutBtn.disabled = true;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

  document.getElementById('clockIn').addEventListener('click', () => handleClock('Clock In'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('Clock Out'));
}

async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Access Denied', 'Please allow camera access and try again.', false, true);
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
    console.log('Face proxy returned:', j);

    if (j?.result?.length && j.result[0].subjects?.length) {
      const top = j.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) || 0 };
    }

    if (j?.message) return { ok: false, error: j.message };
    return { ok: false, error: 'No face match found. Please try again.' };
  } catch (err) {
    console.error('validateFaceWithProxy error', err);
    return { ok: false, error: 'Unable to connect to the recognition server. Check your network and retry.' };
  }
}

async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'Unable to detect your GPS position. Please ensure location is enabled.', false, true);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  await new Promise(r => setTimeout(r, 1000));

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640;
  tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  showLoader("Verifying your identity...");

  const faceRes = await validateFaceWithProxy(base64);
  hideLoader();

  if (!faceRes.ok) {
    return showPopup('Face Not Recognized', faceRes.error || 'We could not identify your face. Please ensure good lighting and face the camera directly.', false, true);
  }

  if (faceRes.similarity < 0.55) {
    return showPopup('Low Match Confidence', `Your face was detected but similarity is too low (${(faceRes.similarity * 100).toFixed(1)}%). Try again with better lighting.`, false, true);
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

    if (j.success) {
      showPopup('Verification Successful', j.message || `Welcome ${faceRes.subject}, ${action} recorded successfully.`, true);
    } else {
      showPopup('Attendance Failed', j.message || 'Attendance could not be logged. Please try again.', false, true);
    }
  } catch (err) {
    console.error('Attendance API error', err);
    showPopup('Server Error', 'Unable to record attendance. Please check your network and try again later.', false, true);
  }
}

window.onload = startLocationWatch;
window.onunload = () => { if (watchId) navigator.geolocation.clearWatch(watchId); stopVideo(); };
