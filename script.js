let watchId = null, videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry, loaderEl;
let locations = [], popupTimeout = null, locationErrorShown = false;
let currentStaffId = null, currentStaffName = null, currentUserId = null;

function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);
  popupHeader.textContent = title;
  popupHeader.className = 'popup-header';
  if (success === true) popupHeader.classList.add('success');
  else if (success === false) popupHeader.classList.add('error');
  popupMessage.innerHTML = message;
  popupFooter.textContent = new Date().toLocaleString('en-US', {weekday:'long', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
  popupRetry.innerHTML = '<button id="popupCloseBtn" class="popup-close-btn">Close</button>';
  popupEl.style.display = 'flex'; popupEl.classList.add('show');
  popupTimeout = setTimeout(() => { popupEl.classList.remove('show'); popupEl.style.display = 'none'; }, 5000);
  document.getElementById('popupCloseBtn').onclick = () => { popupEl.classList.remove('show'); popupEl.style.display = 'none'; };
}

function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}
function hideLoader() { if (loaderEl) loaderEl.style.display = "none"; }

async function fetchLocations() {
  try {
    showLoader("Loading locations...");
    const res = await fetch('/api/locations');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error('Invalid data');
    locations = data.locations;
    hideLoader();
    return true;
  } catch (e) {
    hideLoader();
    showPopup('Location Error', `Failed to load locations: ${e.message}`, false);
    return false;
  }
}

function startLocationWatch() {
  const statusEl = document.getElementById('status'), locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn'), clockOutBtn = document.getElementById('clockOut');
  const staffIdInput = document.getElementById('staffId'), idError = document.getElementById('idError');

  videoEl = document.getElementById('video');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  fetchLocations().then(ok => {
    if (!ok) { statusEl.textContent = 'Location load failed.'; clockInBtn.disabled = clockOutBtn.disabled = true; return; }
    if (!navigator.geolocation) { showPopup('Geolocation Error', 'Browser doesn’t support geolocation.', false); return; }

    watchId = navigator.geolocation.watchPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        let office = null;
        for (const loc of locations) {
          if (getDistanceKm(latitude, longitude, loc.lat, loc.long) <= loc.radiusMeters / 1000) { office = loc.name; break; }
        }
        if (office) {
          statusEl.textContent = `${office}`;
          locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude; locationEl.dataset.long = longitude;
          const validId = /^\d{3}$/.test(staffIdInput.value.trim());
          clockInBtn.disabled = clockOutBtn.disabled = !validId;
          locationErrorShown = false;
        } else if (!locationErrorShown) {
          statusEl.textContent = 'Unapproved Location';
          clockInBtn.disabled = clockOutBtn.disabled = true;
          showPopup('Location Error', 'Not at an approved office.', false);
        }
      },
      err => { statusEl.textContent = `Location error: ${err.message}`; clockInBtn.disabled = clockOutBtn.disabled = true; },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    const updateButtons = () => {
      const valid = /^\d{3}$/.test(staffIdInput.value.trim());
      clockInBtn.disabled = clockOutBtn.disabled = !valid;
      idError.textContent = valid ? '' : 'Enter 3-digit UserID';
    };
    staffIdInput.addEventListener('input', updateButtons);
    updateButtons();

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));
  });
}

async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Access denied: ${err.message}`, false);
    return false;
  }
}
function stopVideo() { if (videoEl && videoEl.srcObject) videoEl.srcObject.getTracks().forEach(t => t.stop()); }

async function validateFaceWithProxyTargeted(base64, targetSubject) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: targetSubject })
    });
    if (!res.ok) return { ok: false, error: `Service error: ${await res.text()}` };
    const data = await res.json();
    if (!data?.result?.length || !data.result[0].subjects?.length) return { ok: false, noSubject: true };
    const match = data.result[0].subjects[0];
    if (match.subject !== targetSubject) return { ok: false, noSubject: true };
    return { ok: true, similarity: Number(match.similarity) || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleClock(action) {
  currentUserId = document.getElementById('staffId').value.trim();
  if (!/^\d{3}$/.test(currentUserId)) {
    showPopup('Invalid UserID', 'Enter your 3-digit UserID.', false);
    return;
  }

  showLoader('Verifying UserID...');
  let staffName, comprefaceSubject;
  try {
    const res = await fetch(`/api/staff/${currentUserId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Not found');
    staffName = data.name;
    comprefaceSubject = data.comprefaceSubject;
    currentStaffName = staffName;
  } catch (err) {
    hideLoader();
    showPopup('UserID Error', err.message, false);
    return;
  }
  hideLoader();

  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat), long = Number(locationEl.dataset.long);
  if (!lat || !long) { showPopup('Location Error', 'No GPS data.', false); return; }
  let office = null;
  for (const loc of locations) {
    if (getDistanceKm(lat, long, loc.lat, loc.long) <= loc.radiusMeters / 1000) { office = loc.name; break; }
  }
  if (!office) { showPopup('Location Error', 'Not at an approved office.', false); return; }

  document.getElementById('faceRecognition').style.display = 'block';
  if (!await startVideo()) return;
  await new Promise(r => setTimeout(r, 1000));
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640; tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];
  stopVideo(); document.getElementById('faceRecognition').style.display = 'none';

  showLoader('Verifying face...');
  const faceRes = await validateFaceWithProxyTargeted(base64, comprefaceSubject);

  if (!faceRes.ok) {
    hideLoader();
    if (faceRes.noSubject) showPopup('Face Not Found', `Dear ${staffName}, your face was not found.`, false);
    else showPopup('Face Error', faceRes.error || 'Verification failed.', false);
    return;
  }
  if (faceRes.similarity < 0.9) {
    hideLoader();
    showPopup('Face Similarity Too Low', `Dear ${staffName}, face similarity too low (${(faceRes.similarity*100).toFixed(1)}%). Try better lighting.`, false);
    return;
  }

  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId: currentUserId, subjectName: staffName, latitude: lat, longitude: long, timestamp: new Date().toISOString() })
    });
    const data = await res.json(); hideLoader();
    if (data.success) showPopup('Success', data.message, true);
    else showPopup('Error', data.message, false);
  } catch (err) {
    hideLoader();
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}

document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => { if (watchId) navigator.geolocation.clearWatch(watchId); stopVideo(); };
