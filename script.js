// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];
let popupTimeout = null;
let locationErrorShown = false;
let currentStaffId = null;     // ID entered by user
let currentStaffName = null;   // Full name from sheet

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

// Show popup
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);
  popupHeader.textContent = title;
  popupHeader.className = 'popup-header';
  if (success === true) popupHeader.classList.add('success');
  else if (success === false) popupHeader.classList.add('error');
  popupMessage.innerHTML = message;
  popupMessage.innerHTML += success === true
    ? '<div class="popup-icon success">Success</div>'
    : success === false
      ? '<div class="popup-icon error">Error</div>'
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
    if (title === 'Location Error' && success === false) locationErrorShown = true;
  }, 5000);
  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) closeBtn.onclick = () => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
    if (title === 'Location Error' && success === false) locationErrorShown = true;
  };
}

// Loader
function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}
function hideLoader() { if (loaderEl) loaderEl.style.display = "none"; }

// Fetch locations
async function fetchLocations() {
  try {
    showLoader("Loading locations...");
    const response = await fetch('/api/locations', { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success || !Array.isArray(data.locations)) throw new Error('Invalid data');
    locations = data.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    hideLoader();
    return true;
  } catch (error) {
    hideLoader();
    showPopup('Location Error', `Failed to load locations: ${error.message}`, false);
    return false;
  }
}

// Start location watch
function startLocationWatch() {
  const statusEl = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');
  const staffIdInput = document.getElementById('staffId');
  const idError = document.getElementById('idError');

  if (!statusEl || !locationEl || !clockInBtn || !clockOutBtn || !staffIdInput) {
    showPopup('Init Error', 'Missing elements. Reload.', false);
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
    if (!ok) {
      statusEl.textContent = 'Location load failed.';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }
    if (!navigator.geolocation) {
      statusEl.textContent = 'Geolocation not supported.';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      showPopup('Geolocation Error', 'Browser doesn’t support geolocation.', false);
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
          statusEl.textContent = `${office}`;
          locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude;
          locationEl.dataset.long = longitude;
          clockInBtn.disabled = clockOutBtn.disabled = !/^\d{3}$/.test(staffIdInput.value.trim());
          clockInBtn.style.opacity = clockOutBtn.style.opacity = "1";
          locationErrorShown = false;
        } else if (!locationErrorShown) {
          statusEl.textContent = 'Unapproved Location';
          locationEl.textContent = `Location: Unapproved\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude;
          locationEl.dataset.long = longitude;
          clockInBtn.disabled = clockOutBtn.disabled = true;
          clockInBtn.style.opacity = clockOutBtn.style.opacity = "0.6";
          const msg = currentStaffName
            ? `Dear ${currentStaffName}, you are not allowed to clock in/out here.`
            : 'Not at an approved office.';
          showPopup('Location Error', msg, false);
        }
      },
      err => {
        statusEl.textContent = `Location error: ${err.message}`;
        clockInBtn.disabled = clockOutBtn.disabled = true;
        if (!locationErrorShown) showPopup('Location Error', `GPS failed: ${err.message}`, false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    // ID validation
    const updateButtons = () => {
      const valid = /^\d{3}$/.test(staffIdInput.value.trim());
      clockInBtn.disabled = clockOutBtn.disabled = !valid;
      idError.textContent = valid ? '' : 'Enter 3 digits';
    };
    staffIdInput.addEventListener('input', updateButtons);
    updateButtons();

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));

    // Admin dashboard
    const adminBtn = document.getElementById('adminDashboard');
    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        const adminPopup = document.getElementById('adminPopup');
        if (adminPopup) {
          adminPopup.classList.add('show');
          document.getElementById('adminError').textContent = "";
          document.getElementById('adminEmail').value = "";
          document.getElementById('adminPassword').value = "";
        } else {
          showPopup('Init Error', 'Admin popup missing.', false);
        }
      });
    }
  });
}

// Video
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
function stopVideo() {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

// Targeted face verification
async function validateFaceWithProxyTargeted(base64, targetSubject) {
  try {
    const response = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64, subject: targetSubject })
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Service error: ${text}` };
    }
    const data = await response.json();
    if (!data?.result?.length || !data.result[0].subjects?.length) {
      return { ok: false, noSubject: true };
    }
    const match = data.result[0].subjects[0];
    if (match.subject !== targetSubject) {
      return { ok: false, noSubject: true };
    }
    return { ok: true, similarity: Number(match.similarity) || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Handle clock in/out
async function handleClock(action) {
  // 1. Validate ID
  currentStaffId = document.getElementById('staffId')?.value.trim();
  if (!/^\d{3}$/.test(currentStaffId)) {
    showPopup('Invalid ID', 'Please enter your 3-digit staff ID.', false);
    return;
  }

  // 2. Fetch staff name
  showLoader('Verifying ID...');
  let staffName;
  try {
    const res = await fetch(`/api/staff/${currentStaffId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.success || !data.name) throw new Error('Staff not found');
    staffName = data.name;
  } catch (err) {
    hideLoader();
    showPopup('ID Error', `ID ${currentStaffId} not found. Contact HR.`, false);
    return;
  }
  currentStaffName = staffName;
  hideLoader();

  // 3. Location check
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) { showPopup('Location Error', 'No GPS data.', false); return; }
  let office = null;
  for (const loc of locations) {
    const distKm = getDistanceKm(lat, long, loc.lat, loc.long);
    if (distKm <= loc.radiusMeters / 1000) { office = loc.name; break; }
  }
  if (!office) { showPopup('Location Error', 'Not at an approved office.', false); return; }

  // 4. Face verification (targeted)
  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;
  await new Promise(r => setTimeout(r, 1000));
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640; tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg').split(',')[1];
  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  showLoader('Verifying face...');
  const subjectToCheck = `${currentStaffId.padStart(3,'0')} ${staffName}`;
  const faceRes = await validateFaceWithProxyTargeted(base64, subjectToCheck);

  if (!faceRes.ok) {
    hideLoader();
    if (faceRes.noSubject) {
      showPopup('Face Not Registered', `Dear ${staffName}, your face has not been added. See HR.`, false);
    } else {
      showPopup('Face Error', faceRes.error || 'Verification failed.', false);
    }
    return;
  }
  if (faceRes.similarity < 0.9) {
    hideLoader();
    showPopup('Face Error', 'Face not clear. Try better lighting.', false);
    return;
  }

  // 5. Submit attendance
  try {
    const response = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: subjectToCheck,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const data = await response.json();
    hideLoader();
    if (data.success) {
      showPopup('Verification Successful', `Dear ${staffName}, ${action} recorded at ${office}.`, true);
    } else {
      const messages = {
        'Staff not found or inactive': `${staffName}, profile issue. Contact HR.`,
        'Not inside any registered office location': 'Not at an approved location.',
        'Unapproved Location': `${staffName}, unauthorized location.`,
        'Dear': `${staffName}, ${data.message.toLowerCase()}`,
        'Invalid input': 'Invalid data. Try again.'
      };
      showPopup('Attendance Error', messages[data.message] || data.message || 'Not logged.', false);
    }
  } catch (err) {
    hideLoader();
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}

// Admin login (unchanged)
async function fetchAdminLogins() {
  try {
    showLoader('Logging in...');
    const response = await fetch('/api/admin-logins', { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();
    hideLoader();
    return data.success ? data.logins : [];
  } catch (error) {
    hideLoader();
    showPopup('Admin Error', `Failed to fetch admin logins: ${error.message}`, false);
    return [];
  }
}
function loginAdmin() {
  const email = document.getElementById('adminEmail')?.value.trim();
  const password = document.getElementById('adminPassword')?.value.trim();
  const adminError = document.getElementById('adminError');
  const adminPopup = document.getElementById('adminPopup');
  if (!email || !password) { adminError.textContent = 'Fill both fields.'; return; }
  fetchAdminLogins().then(logins => {
    const valid = logins.find(r => r[0] === email && r[1] === password);
    if (valid) {
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('lastActivity', Date.now());
      adminPopup.classList.remove('show');
      window.location.href = 'stats.html';
    } else {
      adminError.textContent = 'Invalid email or password.';
    }
  });
}

// Close admin popup on outside click
document.addEventListener('DOMContentLoaded', () => {
  const adminPopup = document.getElementById('adminPopup');
  if (adminPopup) {
    adminPopup.addEventListener('click', e => { if (e.target === adminPopup) adminPopup.classList.remove('show'); });
  }
  startLocationWatch();
  initSessionTimeout();
});

window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};

// Session timeout
function initSessionTimeout() {
  let timeoutId;
  const SESSION_TIMEOUT = 86400000;
  const isLoggedIn = () => localStorage.getItem('isLoggedIn') === 'true';
  const logout = () => {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('lastActivity');
    clearTimeout(timeoutId);
    window.location.href = 'index.html';
  };
  const resetTimeout = () => {
    const last = localStorage.getItem('lastActivity');
    if (last && Date.now() - parseInt(last, 10) >= SESSION_TIMEOUT) { logout(); return; }
    localStorage.setItem('lastActivity', Date.now());
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => { alert('Session expired.'); logout(); }, SESSION_TIMEOUT);
  };
  if (isLoggedIn() && window.location.pathname !== '/index.html') {
    localStorage.setItem('lastActivity', Date.now());
    resetTimeout();
    ['mousemove','keypress','click','scroll'].forEach(ev => document.addEventListener(ev, resetTimeout));
  }
}
