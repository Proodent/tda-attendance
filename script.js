// === HANDLE CLOCK (Replace entire function) ===
async function handleClock(action) {
  const userIdInput = document.getElementById('userId');
  const userId = userIdInput.value.trim();
  if (!userId) return showPopup('Missing User ID', 'Please enter your User ID.', false);

  const staff = await getStaffByUserId(userId);
  if (!staff) return showPopup('Invalid User ID', 'User not found.', false);
  if (staff.active.toLowerCase() !== 'yes') return showPopup('Access Denied', 'Staff is Inactive.', false);

  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'No GPS data.', false);

  let office = null;
  for (const loc of locations) {
    const distKm = getDistanceKm(lat, long, loc.lat, loc.long);
    if (distKm <= loc.radiusMeters / 1000) {
      office = loc.name;
      break;
    }
  }
  if (!office) return showPopup('Location Error', 'Not at an approved office.', false);

  // === STEP 1: OPEN CAMERA POPUP ===
  cameraPopup = document.getElementById('cameraPopup');
  cameraPopup.classList.add('show');

  const started = await startVideo();
  if (!started) {
    closeCamera();
    return;
  }

  // === STEP 2: SHOW FACE FOR 1.5 SECONDS ===
  const captureMsg = document.createElement('div');
  captureMsg.textContent = `Capturing ${staff.name}...`;
  captureMsg.style.cssText = `
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    background: rgba(0,146,69,0.9); color: white; padding: 8px 16px;
    border-radius: 20px; font-weight: bold; font-size: 14px; z-index: 10;
  `;
  document.getElementById('cameraContainer').appendChild(captureMsg);

  await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s visible

  // === STEP 3: CAPTURE IMAGE ===
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 640; tempCanvas.height = 480;
  const ctx = tempCanvas.getContext('2d');
  ctx.translate(tempCanvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];

  // === STEP 4: CLOSE CAMERA + SHOW LOADER ===
  captureMsg.remove();
  closeCamera();
  showLoader(`Verifying face of ${staff.name}...`);

  // === STEP 5: FACE RECOGNITION ===
  const faceRes = await validateFaceWithSubject(base64, staff.name);

  if (!faceRes.ok) {
    hideLoader();
    const msg = faceRes.error === 'Face not found' ? 'Face not found in database' :
                faceRes.error.includes('unavailable') ? 'Face service unavailable' :
                'Face verification failed';
    return showPopup('Face Verification Failed', msg, false);
  }

  if (faceRes.similarity < 0.7) {
    hideLoader();
    return showPopup('Face Verification Failed', `Match too weak: ${(faceRes.similarity * 100).toFixed(1)}%`, false);
  }

  // === STEP 6: SUBMIT ATTENDANCE ===
  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        subjectName: staff.name,
        userId,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString()
      })
    });
    const data = await res.json();
    hideLoader();
    if (data.success) {
      showPopup('Success', `Dear ${staff.name}, ${action === 'clock in' ? 'clock-in' : 'clock-out'} recorded at ${office}.`, true);
    } else {
      showPopup('Attendance Error', data.message, false);
    }
  } catch (err) {
    hideLoader();
    showPopup('Server Error', `Connection failed: ${err.message}`, false);
  }
}
