// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
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
    const response = await fetch('/api/locations', { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
    const data = await response.json();
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
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Access denied: ${err.message}`, false);
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
    const response = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    if (!response.ok) return { ok: false, error: 'Service unavailable' };
    const data = await response.json();
    console.log('Face data:', data);
    if (data?.result?.length && data.result[0].subjects?.length) {
      const top = data.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) || 0 };
    }
    return { ok: false, error: data?.message || 'No match found' };
  } catch (err) {
    console.error('Face error:', err);
    return { ok: false, error: err.message || 'Service error' };
  }
}

// Handle clock in/out
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) {
    showPopup('Location Error', 'No GPS data.', false);
    return;
  }

  let office = null;
  for (const loc of locations) {
    const distKm = getDistanceKm(lat, long, loc.lat, loc.long);
    if (distKm <= loc.radiusMeters / 1000) {
      office = loc.name;
      break;
    }
  }
  if (!office) {
    showPopup('Location Error', 'Not at an approved office.', false);
    return;
  }

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

  showLoader(`${action === 'clock in' ? 'Clocking In' : 'Clocking Out'}...`);

  const faceRes = await validateFaceWithProxy(base64);
  if (!faceRes.ok) {
    hideLoader();
    showPopup('Face Error', faceRes.error || 'No match.', false');
    return;
  }
  if (faceRes.similarity < 0.85) {
    hideLoader();
    showPopup('Face Error', 'Low similarity. Try better lighting.', false);
    return;
  }

  try {
    const response = await fetch('/api/attendance/web', {
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
    const data = await response.json();
    hideLoader();

    if (data.success) {
      showPopup('Success', `${faceRes.subject}, ${action} recorded at ${office}.`, true);
    } else {
      const messages = {
        'Staff not found or inactive': `${faceRes.subject}, profile issue. Contact HR.`,
        'Not inside any registered office location': 'Not at an approved location.',
        'Unapproved Location': `${faceRes.subject}, unauthorized location.`,
        'Dear': `${faceRes.subject}, ${data.message.toLowerCase()}`,
        'Invalid input': 'Invalid data. Try again.'
      };
      showPopup('Error', messages[data.message] || data.message || 'Not logged.', false);
    }
  } catch (err) {
    hideLoader();
    console.error('Attendance error:', err);
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}

// Fetch admin logins from server
async function fetchAdminLogins() {
  try {
    showLoader('Fetching admin logins...');
    const response = await fetch('/api/admin-logins', { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
    const data = await response.json();
    console.log('Admin logins data:', data);
    hideLoader();
    return data.success ? data.logins : [];
  } catch (error) {
    console.error('Admin fetch error:', error);
    hideLoader();
    showPopup('Admin Error', `Failed to fetch admin logins: ${error.message}. Check server and Admin Logins sheet.`, false);
    return [];
  }
}

// Handle admin login
function loginAdmin() {
  const email = document.getElementById('adminEmail')?.value.trim();
  const password = document.getElementById('adminPassword')?.value.trim();
  const adminError = document.getElementById('adminError');
  const adminPopup = document.getElementById('adminPopup');

  if (!email || !password || !adminError || !adminPopup) {
    console.error('Missing login elements:', { email, password, adminError, adminPopup });
    showPopup('Init Error', 'Login form incomplete. Reload.', false);
    return;
  }

  if (!email || !password) {
    adminError.textContent = 'Please fill in both fields.';
    return;
  }

  fetchAdminLogins().then(adminLogins => {
    if (adminLogins.length === 0) {
      adminError.textContent = 'No admin logins found. Check server configuration.';
      return;
    }

    const validLogin = adminLogins.find(row => row[0] === email && row[1] === password);
    console.log('Login check:', { email, password, adminLogins });

    if (validLogin) {
      adminPopup.classList.remove('show');
      window.location.href = 'stats.html';
    } else {
      adminError.textContent = 'Invalid email or password.';
    }
  });
}

// Close admin popup if clicked outside
document.addEventListener('DOMContentLoaded', () => {
  const adminPopup = document.getElementById('adminPopup');
  if (adminPopup) {
    adminPopup.addEventListener('click', e => {
      if (e.target === adminPopup) adminPopup.classList.remove('show');
    });
  }
});

document.addEventListener('DOMContentLoaded', startLocationWatch);
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
