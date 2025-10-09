// ==================== GLOBALS ====================
let watchId = null;
let video, canvas, popup, popupHeader, popupMessage, popupFooter, popupRetry;
let popupTimeout;
let locationsData = [];
let locationsLoaded = false;

// ==================== FETCH LOCATIONS ====================
async function loadLocations() {
  const status = document.getElementById('status');
  status.innerHTML = 'Fetching office data... ⏳';

  try {
    const res = await fetch('/api/locations');
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) throw new Error('No location data found');
    locationsData = data.map(loc => ({
      name: loc['Location Name'],
      lat: parseFloat(loc['Latitude']),
      lon: parseFloat(loc['Longitude']),
      radius: parseFloat(loc['Radius'])
    }));

    console.log('✅ Loaded locations:', locationsData);
    locationsLoaded = true;
    status.innerHTML = 'Location data loaded. Detecting your position... 📍';
  } catch (err) {
    console.error('❌ Error loading locations:', err);
    status.textContent = 'Error loading office data. Please reload.';
    showPopup('Error', 'Unable to load location data. Please reload.', true);
  }
}

// ==================== GEO DISTANCE HELPER ====================
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ==================== FIND CURRENT OFFICE ====================
function getCurrentOffice(lat, lon) {
  for (const loc of locationsData) {
    const distance = getDistance(lat, lon, loc.lat, loc.lon);
    if (distance <= loc.radius) return loc.name;
  }
  return null;
}

// ==================== LOCATION WATCH ====================
async function startLocationWatch() {
  const status = document.getElementById('status');
  const location = document.getElementById('location');
  const clockIn = document.getElementById('clockIn');
  const clockOut = document.getElementById('clockOut');

  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  popup = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  // Load locations first
  await loadLocations();

  if (!navigator.geolocation) {
    status.textContent = 'Geolocation not supported by your browser.';
    clockIn.disabled = clockOut.disabled = true;
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!locationsLoaded) return; // wait until sheet data is ready

      const { latitude, longitude } = pos.coords;
      const currentOffice = getCurrentOffice(latitude, longitude);

      if (currentOffice) {
        status.innerHTML = `✅ You are currently at <b>${currentOffice}</b>`;
        location.textContent = `GPS Location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        clockIn.disabled = clockOut.disabled = false;
      } else {
        status.innerHTML = '❌ Unapproved Location';
        location.textContent = `GPS Location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        clockIn.disabled = clockOut.disabled = true;
      }
    },
    (err) => {
      status.textContent = `Error getting location: ${err.message}`;
      clockIn.disabled = clockOut.disabled = true;
    },
    { enableHighAccuracy: true, maximumAge: 10000 }
  );

  document.getElementById('clockIn').addEventListener('click', () => handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('clock out'));
}

// ==================== CAMERA & FACE VALIDATION ====================
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = stream;
    video.style.transform = 'scaleX(-1)';
    await video.play();
  } catch (err) {
    showPopup('Verification Unsuccessful', `Camera error: ${err.message}`, true);
    throw err;
  }
}

function stopVideo() {
  if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

async function validateFace(imageData) {
  try {
    const response = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData })
    });

    const result = await response.json();
    console.log('Face API response:', result);

    if (result?.result?.length && result.result[0].subjects?.length) {
      const match = result.result[0].subjects[0];
      if (match.similarity >= 0.7) {
        return { success: true, subjectName: match.subject };
      } else {
        return { success: false, error: 'Face match too low. Try again.' };
      }
    }

    return { success: false, error: 'No matching face found. Try again.' };
  } catch (err) {
    return { success: false, error: `Face API error: ${err.message}` };
  }
}

// ==================== ATTENDANCE HANDLER ====================
async function handleClock(action) {
  const faceRecognition = document.getElementById('faceRecognition');
  const locationText = document.getElementById('location').textContent;
  const statusText = document.getElementById('status').textContent;

  if (statusText.includes('Unapproved') || !statusText.includes('at')) {
    return showPopup('Location Error', 'You are not within an approved office location.', true);
  }

  const officeName = statusText.replace(/.*at\s*/, '').replace(/<\/?b>/g, '').trim();
  const [latStr, lonStr] = locationText.replace('GPS Location: ', '').split(', ');
  const latitude = parseFloat(latStr);
  const longitude = parseFloat(lonStr);

  faceRecognition.style.display = 'block';
  await startVideo();

  const canvasTemp = document.createElement('canvas');
  canvasTemp.width = 640;
  canvasTemp.height = 480;
  const ctx = canvasTemp.getContext('2d');

  ctx.translate(canvasTemp.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvasTemp.width, canvasTemp.height);

  const imageData = canvasTemp.toDataURL('image/jpeg').split(',')[1];
  stopVideo();

  const face = await validateFace(imageData);
  if (!face.success) {
    return showPopup('Verification Unsuccessful', face.error, true);
  }

  try {
    const response = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: face.subjectName,
        latitude,
        longitude,
        office: officeName,
        timestamp: new Date().toISOString()
      })
    });

    const result = await response.json();
    if (result.success) {
      showPopup(
        'Verification Successful',
        `Dear ${face.subjectName}, you have successfully ${action} at ${new Date().toLocaleTimeString()}, at ${officeName}.`
      );
    } else {
      showPopup('Verification Unsuccessful', result.message || 'Attendance not logged.', true);
    }

  } catch (err) {
    showPopup('Server Error', `Failed to log attendance: ${err.message}`, true);
  }
}

// ==================== POPUP HELPER ====================
function showPopup(title, message, retry = false) {
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.textContent = message;
  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = retry ? '<button onclick="window.location.reload()">Retry</button>' : '';

  popup.style.display = 'block';
  popupTimeout = setTimeout(() => popup.style.display = 'none', retry ? 8000 : 5000);
}

// ==================== CLEANUP ====================
window.onload = startLocationWatch;
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
