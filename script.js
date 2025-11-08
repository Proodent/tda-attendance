let currentOffice = null;
let staffCache = new Map();

// === FACE MODAL AUTO-CAPTURE ===
let faceModal, videoEl, captureStatus;
let countdown = 0;
let countdownInterval = null;

async function showFaceModal(staff, action) {
  faceModal = document.getElementById('faceModal');
  videoEl = document.getElementById('video');
  captureStatus = document.getElementById('captureStatus');

  faceModal.classList.add('show');
  const started = await startVideo();
  if (!started) {
    hideFaceModal();
    return;
  }

  // Auto-capture countdown
  countdown = 3;
  captureStatus.textContent = `Capturing in ${countdown}...`;
  countdownInterval = setInterval(async () => {
    countdown--;
    if (countdown > 0) {
      captureStatus.textContent = `Capturing in ${countdown}...`;
    } else {
      clearInterval(countdownInterval);
      captureStatus.textContent = "Verifying...";
      await captureAndVerify(staff, action);
    }
  }, 1000);
}

function hideFaceModal() {
  if (faceModal) faceModal.classList.remove('show');
  if (countdownInterval) clearInterval(countdownInterval);
  stopVideo();
}

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
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

async function captureAndVerify(staff, action) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  hideFaceModal();
  showLoader(`Verifying face for ${staff.name}...`);

  const faceRes = await validateFaceWithSubject(base64, staff.name);
  hideLoader();

  if (!faceRes.ok || faceRes.similarity < 0.7) {
    showPopup('Face Verification Failed', faceRes.error || 'Face similarity too low.', false);
    return;
  }

  await submitAttendance(action, staff);
}

// === HANDLE CLOCK ===
async function handleClock(action) {
  const userId = document.getElementById('userId').value.trim();
  if (!userId) return showPopup('Missing User ID', 'Please enter your User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff || staff.active.toLowerCase() !== 'yes') {
    return showPopup('Invalid User ID', 'User not found or inactive.', false);
  }

  const locEl = document.getElementById('location');
  const lat = Number(locEl.dataset.lat);
  const long = Number(locEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'No GPS data.', false);

  if (!currentOffice) return showPopup('Location Error', 'Not at an approved office.', false);
  if (!staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase())) {
    return showPopup('Location Denied', `You are not allowed at ${currentOffice}.`, false);
  }

  showFaceModal(staff, action);
}

// === USERID STATUS WITH ICONS ===
async function updateUserStatus() {
  const userId = document.getElementById('userId').value.trim();
  const statusEl = document.getElementById('userIdStatus');
  const buttons = [document.getElementById('clockIn'), document.getElementById('clockOut')];

  if (!userId) {
    statusEl.className = 'loading';
    statusEl.innerHTML = 'Enter User ID...';
    buttons.forEach(b => b.disabled = true);
    return;
  }

  statusEl.className = 'loading';
  statusEl.innerHTML = 'Validating...';

  const staff = await getStaffByUserId(userId);
  if (!staff) {
    statusEl.className = 'invalid';
    statusEl.innerHTML = `User ${userId} not found <span class="status-icon">Cross</span>`;
    buttons.forEach(b => b.disabled = true);
    return;
  }

  if (staff.active.toLowerCase() !== 'yes') {
    statusEl.className = 'inactive';
    statusEl.innerHTML = `User ${userId} : ${staff.name} is Inactive <span class="status-icon">Warning</span>`;
    buttons.forEach(b => b.disabled = true);
    return;
  }

  const approved = currentOffice && staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase());
  const icon = approved ? 'Checkmark' : 'Cross';
  const colorClass = approved ? 'valid' : 'invalid';

  statusEl.className = colorClass;
  statusEl.innerHTML = `User ${userId} found : ${staff.name} <span class="status-icon">${icon}</span>`;
  buttons.forEach(b => b.disabled = !approved);
}

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('userId').addEventListener('input', updateUserStatus);
  document.getElementById('clockIn').addEventListener('click', () => handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', () => handleClock('clock out'));
  document.getElementById('adminDashboard').addEventListener('click', () => {
    document.getElementById('adminPopup').classList.add('show');
  });
});
