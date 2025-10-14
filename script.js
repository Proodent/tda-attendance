// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl, faceProgress;
let locations = [];
let popupTimeout = null;

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

// Show popup with success/error icon and optional retry button
function showPopup(title, message, success = null, retry = false) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.innerHTML = message;
  if (success === true) {
    popupMessage.innerHTML += '<div class="popup-icon success">✔️</div>';
  } else if (success === false) {
    popupMessage.innerHTML += '<div class="popup-icon error">❌</div>';
  }

  popupFooter.textContent = new Date().toLocaleString('en-US', { 
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });
  popupRetry.innerHTML = retry ? '<button id="popupRetryBtn">Retry</button>' : '';
  popupEl.classList.add('show');

  if (retry) {
    document.getElementById('popupRetryBtn').onclick = () => window.location.reload();
  }

  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  }, 5000);
}

// Show loader during async operations
function showLoader(text = "Verifying...") {
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}

// Hide loader
function hideLoader() {
  if (loaderEl) loaderEl.style.display = "none";
}

// Fetch office locations from server
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
    console.log('Loaded locations:', locations);
    return true;
  } catch (err) {
    console.error('Error loading locations:', err);
    showPopup('Error', 'Unable to load location data. Please reload.', false, true);
    return false;
  }
}

// Animate progress bar during facial recognition
function animateProgressBar() {
  faceProgress.value = 0;
  let progress = 0;
  const interval = setInterval(() => {
    progress += 5;
    faceProgress.value = progress;
    if (progress >= 100) clearInterval(interval);
  }, 100);
}

// Start location monitoring
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
  loaderEl = document.getElementById('loaderOverlay');
  faceProgress = document.getElementById('faceProgress');

  // Handle popup close button
  document.querySelector('.popup-close').onclick = () => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  };

  // Handle dark mode toggle
  document.getElementById('themeToggle').onclick = () => {
    document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
  };

  // Load saved theme
  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
  }

  // Show loader while fetching locations
  showLoader("Loading locations...");
  const ok = await fetchLocations();
  hideLoader();
  if (!ok) return;

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
      if (distKm <= (o.radiusMeters / 1000)) {
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

  document.getElementById('clockIn').addEventListener('click', () => handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('clock out'));
}

// Start video for facial recognition
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Verification Unsuccessful', `Camera error: ${err.message}`, false, true);
    return false;
  }
}

// Stop video stream
function stopVideo() {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

// Validate face via CompreFace proxy
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
    return { ok: false, error: 'No match' };
  } catch (err) {
    console.error('validateFaceWithProxy error', err);
    return { ok: false, error: err.message || 'Face API error' };
  }
}

// Handle clock in/out
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'Unable to detect GPS coordinates.', false, true);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  animateProgressBar();
  await new Promise(r => setTimeout(r, 2000)); // Delay for face capture

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
    return showPopup('Verification Unsuccessful', faceRes.error || 'Face not recognized.', false, true);
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
      showPopup('Verification Successful', `Dear ${faceRes.subject}, ${j.message || `${action} successful.`}`, true);
    } else {
      showPopup('Verification Unsuccessful', j.message || 'Attendance not logged.', false, true);
    }
  } catch (err) {
    hideLoader();
    console.error('Attendance API error', err);
    showPopup('Server Error', `Failed to log attendance: ${err.message}`, false, true);
  }
}

window.onload = startLocationWatch;
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
