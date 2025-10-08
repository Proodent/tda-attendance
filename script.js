// ==================== LOCATION CONFIG (now loaded from sheet via backend) ====================
// (No static OFFICE_LOCATIONS here anymore)

// ==================== GLOBALS ====================
let watchId = null, video, canvas, popup, popupHeader, popupMessage, popupFooter, popupRetry;

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

  if (!navigator.geolocation) {
    status.textContent = 'Geolocation not supported';
    clockIn.disabled = clockOut.disabled = true;
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      location.textContent = `Location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      status.textContent = 'Checking proximity...';
      clockIn.disabled = clockOut.disabled = false;
    },
    (err) => {
      status.textContent = `Error: ${err.message}`;
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

    if (result?.result?.[0]?.subjects?.[0]) {
      const match = result.result[0].subjects[0];
      if (match.similarity >= 0.7)
        return { success: true, subjectName: match.subject };
      else
        return { success: false, error: 'Face match too low. Try again.' };
    }

    return { success: false, error: 'No matching face found.' };
  } catch (err) {
    return { success: false, error: `Face API error: ${err.message}` };
  }
}

// ==================== ATTENDANCE HANDLER ====================
async function handleClock(action) {
  const faceRecognition = document.getElementById('faceRecognition');
  const [latStr, lonStr] = document.getElementById('location').textContent.replace('Location: ', '').split(', ');
  const latitude = parseFloat(latStr);
  const longitude = parseFloat(lonStr);

  if (!latitude || !longitude)
    return showPopup('Location Error', 'Unable to get GPS location.', true);

  faceRecognition.style.display = 'block';
  await startVideo();

  const canvasTemp = document.createElement('canvas');
  canvasTemp.width = 640;
  canvasTemp.height = 480;
  const ctx = canvasTemp.getContext('2d');
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvasTemp.width, 0, canvasTemp.width, canvasTemp.height);
  const imageData = canvasTemp.toDataURL('image/jpeg').split(',')[1];
  stopVideo();

  const face = await validateFace(imageData);
  if (!face.success)
    return showPopup('Verification Unsuccessful', face.error, true);

  // ✅ Send to backend for Google Sheets check
  try {
    const response = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: face.subjectName,
        latitude,
        longitude,
        timestamp: new Date().toISOString()
      })
    });

    const result = await response.json();
    if (result.success)
      showPopup('Verification Successful',
        `Dear ${face.subjectName}, you have successfully ${action} at ${new Date().toLocaleTimeString()}.`);
    else
      showPopup('Verification Unsuccessful', result.message || 'Attendance not logged.', true);

  } catch (err) {
    showPopup('Server Error', `Failed to log attendance: ${err.message}`, true);
  }
}

// ==================== POPUP HELPER ====================
function showPopup(title, message, retry = false) {
  popupHeader.textContent = title;
  popupMessage.textContent = message;
  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = retry ? '<button onclick="window.location.reload()">Retry</button>' : '';
  popup.style.display = 'block';
  setTimeout(() => popup.style.display = 'none', retry ? 8000 : 5000);
}

// ==================== CLEANUP ====================
window.onload = startLocationWatch;
window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};
