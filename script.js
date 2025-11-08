// Global
let watchId = null;
let videoEl, faceModal, captureStatus;
let currentAction = null;
let currentStaff = null;
let autoCaptureTimer = null;

// Utility
function showPopup(title, message, success = null) {
  const popup = document.getElementById('popup');
  const header = document.getElementById('popupHeader');
  const msg = document.getElementById('popupMessage');
  header.textContent = title;
  header.className = 'popup-header';
  if (success === true) header.classList.add('success');
  else if (success === false) header.classList.add('error');
  msg.innerHTML = message;
  popup.classList.add('show');
  document.getElementById('popupCloseBtn').onclick = () => popup.classList.remove('show');
  setTimeout(() => popup.classList.remove('show'), 5000);
}

function showLoader(text) {
  const loader = document.getElementById('loaderOverlay');
  loader.querySelector('p').textContent = text;
  loader.style.display = 'flex';
}
function hideLoader() { document.getElementById('loaderOverlay').style.display = 'none'; }

// Start video
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup('Camera Error', `Access denied: ${err.message}`, false);
    return false;
  }
}
function stopVideo() {
  if (videoEl?.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

// Auto capture countdown
function startAutoCapture() {
  let count = 3;
  captureStatus.textContent = `Capturing in ${count}...`;
  autoCaptureTimer = setInterval(() => {
    count--;
    if (count > 0) {
      captureStatus.textContent = `Capturing in ${count}...`;
    } else {
      clearInterval(autoCaptureTimer);
      captureAndVerify();
    }
  }, 1000);
}

// Capture & verify
async function captureAndVerify() {
  if (!currentStaff) return;
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  hideFaceModal();
  showLoader(`Verifying face for ${currentStaff.name}...`);

  const res = await fetch('/api/proxy/face-recognition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: base64, subject: currentStaff.name })
  });
  const data = await res.json();
  hideLoader();

  let match = null;
  if (data?.result?.[0]?.subjects?.length) {
    match = data.result[0].subjects.find(s => s.subject === currentStaff.name);
  }

  if (!match) return showPopup('Face Failed', 'Face not found', false);
  if (match.similarity < 0.7) return showPopup('Face Failed', 'Face similarity too low', false);

  await submitAttendance(currentAction, currentStaff);
}

// Show face modal + auto capture
async function showFaceModal(action, staff) {
  currentAction = action;
  currentStaff = staff;
  faceModal = document.getElementById('faceModal');
  videoEl = document.getElementById('video');
  captureStatus = document.getElementById('captureStatus');

  faceModal.classList.add('show');
  const started = await startVideo();
  if (started) startAutoCapture();
}

// Hide face modal
function hideFaceModal() {
  if (autoCaptureTimer) clearInterval(autoCaptureTimer);
  faceModal?.classList.remove('show');
  stopVideo();
}

// Submit attendance
async function submitAttendance(action, staff) {
  const loc = document.getElementById('location');
  const lat = loc.dataset.lat, long = loc.dataset.long;
  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: staff.name,
        userId: document.getElementById('userId').value.trim(),
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const data = await res.json();
    showPopup(data.success ? 'Success' : 'Error', data.message, data.success);
  } catch (err) {
    showPopup('Error', 'Server error', false);
  }
}

// Clock handler
async function handleClock(action) {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Error', 'Enter User ID', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') return showPopup('Error', 'Invalid or inactive User ID', false);

  const loc = document.getElementById('location');
  if (!loc.dataset.lat) return showPopup('Error', 'GPS not ready', false);
  if (!currentOffice) return showPopup('Error', 'Not in office', false);
  if (!staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase())) {
    return showPopup('Error', 'Location not allowed', false);
  }

  showFaceModal(action, staff);
}

// UserID validation with icons
async function updateUserStatus() {
  const userId = document.getElementById('userId').value.trim();
  const statusEl = document.getElementById('userIdStatus');
  const buttons = [document.getElementById('clockIn'), document.getElementById('clockOut')];

  if (!userId) {
    statusEl.className = 'loading';
    statusEl.innerHTML = 'Enter ID';
    buttons.forEach(b => b.disabled = true);
    return;
  }

  statusEl.className = 'loading';
  statusEl.innerHTML = 'Checking...';

  const staff = await getStaffByUserId(userId);
  if (!staff) {
    statusEl.className = 'invalid';
    statusEl.innerHTML = `User ${userId} not found <span class="status-icon">Cross</span>`;
    buttons.forEach(b => b.disabled = true);
    return;
  }

  if (staff.active.toLowerCase() !== 'yes') {
    statusEl.className = 'inactive';
    statusEl.innerHTML = `${staff.name} (Inactive) <span class="status-icon">Warning</span>`;
    buttons.forEach(b => b.disabled = true);
    return;
  }

  const allowed = staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice?.toLowerCase());
  statusEl.className = 'valid';
  statusEl.innerHTML = `${staff.name} <span class="status-icon">${allowed ? 'Checkmark' : 'Cross'}</span>`;
  buttons.forEach(b => b.disabled = !allowed);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('userId').addEventListener('input', updateUserStatus);
  document.getElementById('clockIn').onclick = () => handleClock('clock in');
  document.getElementById('clockOut').onclick = () => handleClock('clock out');
  document.getElementById('adminDashboard').onclick = () => document.getElementById('adminPopup').classList.add('show');
  document.getElementById('adminLoginBtn').onclick = () => {
    const email = document.getElementById('adminEmail').value.trim();
    const pass = document.getElementById('adminPassword').value.trim();
    const err = document.getElementById('adminError');
    if (!email || !pass) return err.textContent = 'Fill all fields';
    fetch('/api/admin-logins').then(r => r.json()).then(d => {
      if (d.success && d.logins.some(row => row[0] === email && row[1] === pass)) {
        localStorage.setItem('isLoggedIn', 'true');
        window.location.href = 'stats.html';
      } else err.textContent = 'Invalid credentials';
    });
  };
  startLocationWatch();
});
