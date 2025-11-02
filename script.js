// Global variables
let watchId = null;
let videoEl, canvasEl, popupEl, popupHeader, popupMessage, popupFooter, popupRetry;
let loaderEl;
let locations = [];
let popupTimeout = null;
let locationErrorShown = false; // New flag to track if location error has been shown and closed

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
    if (title === 'Location Error' && success === false) {
      locationErrorShown = true; // Set flag when auto-closed
    }
  }, 5000);

  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) closeBtn.onclick = () => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
    if (title === 'Location Error' && success === false) {
      locationErrorShown = true; // Set flag when manually closed
    }
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
    console.log('Fetching /api/locations at', new Date().toISOString());
    const response = await fetch('/api/locations', { mode: 'cors' });
    console.log('Response status:', response.status);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
    const data = await response.json();
    console.log('Raw data received:', data);
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
    console.error('Location fetch error at', new Date().toISOString(), ':', error);
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
    console.error('Missing DOM elements at', new Date().toISOString(), ':', { statusEl, locationEl, clockInBtn, clockOutBtn });
    showPopup('Init Error', 'Required elements not found. Reload the page.', false);
    return;
  }

  console.log('Initializing location watch at', new Date().toISOString());
  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  popupEl = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  fetchLocations().then(ok => {
    console.log('fetchLocations completed with result:', ok);
    if (!ok) {
      statusEl.textContent = 'Location load failed.';
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

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
          locationErrorShown = false; // Reset flag when at an approved location
        } else if (!locationErrorShown) {
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
        console.error('Geolocation error at', new Date().toISOString(), ':', err);
        statusEl.textContent = `Location error: ${err.message}`;
        clockInBtn.disabled = clockOutBtn.disabled = true;
        if (!locationErrorShown) {
          showPopup('Location Error', `GPS failed: ${err.message}`, false);
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    clockInBtn.addEventListener('click', () => handleClock('clock in'));
    clockOutBtn.addEventListener('click', () => handleClock('clock out'));

    const adminDashboardBtn = document.getElementById('adminDashboard');
    if (adminDashboardBtn) {
      adminDashboardBtn.addEventListener('click', () => {
        console.log('Admin Dashboard clicked at', new Date().toISOString());
        const adminPopup = document.getElementById('adminPopup');
        if (adminPopup) {
          adminPopup.classList.add('show');
          document.getElementById('adminError').textContent = "";
          document.getElementById('adminEmail').value = "";
          document.getElementById('adminPassword').value = "";
        } else {
          console.error('Admin popup missing at', new Date().toISOString());
          showPopup('Init Error', 'Admin popup not found.', false);
        }
      });
    } else {
      console.error('Admin button missing at', new Date().toISOString());
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
    console.error('Camera error at', new Date().toISOString(), ':', err);
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
    console.log('Sending face data to proxy at', new Date().toISOString());
    const response = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 })
    });
    console.log('Proxy response status at', new Date().toISOString(), ':', response.status);
    if (!response.ok) {
      const text = await response.text();
      console.error('Proxy error response at', new Date().toISOString(), ':', text);
      return { ok: false, error: `Service unavailable: ${text}` };
    }
    const data = await response.json();
    console.log('Face recognition data at', new Date().toISOString(), ':', data);
    if (data?.result?.length && data.result[0].subjects?.length) {
      const top = data.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) || 0 };
    }
    return { ok: false, error: data?.message || 'No match found' };
  } catch (err) {
    console.error('Face validation error at', new Date().toISOString(), ':', err);
    return { ok: false, error: err.message || 'Service error' };
  }
}

// Handle clock in/out
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) {
    console.error('No GPS data available at', new Date().toISOString(), ':', { lat, long });
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
    console.error('Not at an approved office at', new Date().toISOString(), ':', { lat, long, locations });
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
  console.log('Captured face image length at', new Date().toISOString(), ':', base64.length);

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  showLoader(`${action === 'clock in' ? 'Clocking In' : 'Clocking Out'}...`);

  const faceRes = await validateFaceWithProxy(base64);
  console.log('Face validation result at', new Date().toISOString(), ':', faceRes);
  if (!faceRes.ok) {
    hideLoader();
    showPopup('Face Error', faceRes.error || 'No match.', false);
    return;
  }
  if (faceRes.similarity < 1) {
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
    console.log('Attendance response status at', new Date().toISOString(), ':', response.status);
    const data = await response.json();
    console.log('Attendance response data at', new Date().toISOString(), ':', data);
    hideLoader();

    if (data.success) {
      showPopup('Verification Successful', `Dear ${faceRes.subject}, ${action} recorded at ${office}.`, true);
    } else {
      const messages = {
        'Staff not found or inactive': `${faceRes.subject}, profile issue. Contact HR.`,
        'Not inside any registered office location': 'Not at an approved location.',
        'Unapproved Location': `${faceRes.subject}, unauthorized location.`,
        'Dear': `${faceRes.subject}, ${data.message.toLowerCase()}`,
        'Invalid input': 'Invalid data. Try again.'
      };
      showPopup('Attendance Error', messages[data.message] || data.message || 'Not logged.', false);
    }
  } catch (err) {
    console.error('Attendance error at', new Date().toISOString(), ':', err);
    hideLoader();
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
    console.log('Admin logins data at', new Date().toISOString(), ':', data);
    hideLoader();
    return data.success ? data.logins : [];
  } catch (error) {
    console.error('Admin fetch error at', new Date().toISOString(), ':', error);
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
    console.error('Missing login elements at', new Date().toISOString(), ':', { email, password, adminError, adminPopup });
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
    console.log('Login check at', new Date().toISOString(), ':', { email, password, adminLogins });

    if (validLogin) {
      localStorage.setItem('isLoggedIn', 'true');
      localStorage.setItem('lastActivity', Date.now());
      adminPopup.classList.remove('show');
      window.location.href = 'stats.html'; // Redirect to a protected page
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

// Session timeout logic (moved to a function to apply only on protected pages)
function initSessionTimeout() {
  let timeoutId;
  const SESSION_TIMEOUT = 86400000; // 24 hours in milliseconds

  const isLoggedIn = () => localStorage.getItem('isLoggedIn') === 'true';
  const logout = () => {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('lastActivity');
    clearTimeout(timeoutId);
    window.location.href = 'index.html'; // Redirect to landing page on logout
  };

  const resetTimeout = () => {
    const lastActivity = localStorage.getItem('lastActivity');
    if (lastActivity) {
      const inactiveTime = Date.now() - parseInt(lastActivity, 10);
      if (inactiveTime >= SESSION_TIMEOUT) {
        logout();
        return;
      }
    }
    localStorage.setItem('lastActivity', Date.now());
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      alert('Session expired due to inactivity. Please log in again.');
      logout();
    }, SESSION_TIMEOUT - (Date.now() - (lastActivity ? parseInt(lastActivity, 10) : 0)));
  };

  // Apply timeout only if logged in and on a protected page
  if (isLoggedIn() && window.location.pathname !== '/index.html') {
    localStorage.setItem('lastActivity', Date.now());
    resetTimeout();
    document.addEventListener('mousemove', resetTimeout);
    document.addEventListener('keypress', resetTimeout);
    document.addEventListener('click', resetTimeout);
    document.addEventListener('scroll', resetTimeout); // Optional: also reset on scroll
  }
}

document.addEventListener('DOMContentLoaded', initSessionTimeout);



