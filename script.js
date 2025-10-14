// Show popup with success/error styling and auto-close
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);
  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupMessage.innerHTML = message;
  
  // Clear previous icon
  const iconEl = popupMessage.querySelector('.popup-icon');
  if (iconEl) iconEl.remove();

  // Add success/error icon
  if (success === true) {
    popupMessage.innerHTML += '<div class="popup-icon success">✔️</div>';
    popupMessage.style.color = '#006837'; // Green success text
  } else if (success === false) {
    popupMessage.innerHTML += '<div class="popup-icon error">❌</div>';
    popupMessage.style.color = '#d32f2f'; // Red error text
  } else {
    popupMessage.style.color = '#444'; // Default text color
  }

  popupFooter.textContent = new Date().toLocaleString('en-US', { 
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  });
  
  // Always show "Close" button
  popupRetry.innerHTML = '<button id="popupCloseBtn" style="background: #006837; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-top: 10px;">Close</button>';
  
  popupEl.classList.add('show');

  // Auto-close after 5 seconds
  popupTimeout = setTimeout(() => {
    popupEl.classList.remove('show');
    popupEl.style.display = 'none';
  }, 5000);

  // Close button handler
  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) {
    closeBtn.onclick = () => {
      clearTimeout(popupTimeout);
      popupEl.classList.remove('show');
      popupEl.style.display = 'none';
    };
  }
}

// Update error handling in handleClock function
async function handleClock(action) {
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'Unable to detect GPS coordinates. Please ensure location services are enabled.', false);

  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  animateProgressBar();
  await new Promise(r => setTimeout(r, 2000));

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
  
  if (!faceRes.ok) {
    hideLoader();
    let errorMsg = 'Face recognition failed.';
    
    if (faceRes.similarity && faceRes.similarity < 0.55) {
      errorMsg = 'Face recognition confidence too low. Please try again with better lighting or positioning.';
    } else if (faceRes.error === 'No match') {
      errorMsg = 'No matching face found in our records. Please ensure you are registered and try again.';
    } else if (faceRes.error.includes('API error')) {
      errorMsg = 'Face recognition service temporarily unavailable. Please try again in a moment.';
    }
    
    return showPopup('Facial Recognition Failed', errorMsg, false);
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
      showPopup('Attendance Recorded Successfully', `Dear ${faceRes.subject}, your ${action === 'clock in' ? 'clock-in' : 'clock-out'} has been recorded.`, true);
    } else {
      let errorMsg = 'Unable to process attendance.';
      
      if (j.message.includes('not found') || j.message.includes('inactive')) {
        errorMsg = `Staff member "${faceRes.subject}" not found or inactive. Please contact HR to update your status.`;
      } else if (j.message.includes('Unapproved Location') || j.message.includes('Not authorized')) {
        errorMsg = `You are not authorized to clock ${action} at this location. Please contact your supervisor.`;
      } else if (j.message.includes('already clocked in')) {
        errorMsg = `You have already clocked in today. Please clock out first.`;
      } else if (j.message.includes('no clock-in found')) {
        errorMsg = `No clock-in record found for today. Please clock in first.`;
      } else if (j.message.includes('Server error')) {
        errorMsg = 'Server temporarily unavailable. Please try again in a moment or contact IT support.';
      }
      
      showPopup('Attendance Processing Failed', errorMsg, false);
    }
  } catch (err) {
    hideLoader();
    console.error('Attendance API error', err);
    showPopup('Server Connection Error', 'Unable to connect to the attendance server. Please check your internet connection and try again.', false);
  }
}

// Update camera error handling
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    videoEl.srcObject = stream;
    videoEl.style.transform = 'scaleX(-1)';
    await videoEl.play();
    return true;
  } catch (err) {
    let errorMsg = 'Camera access denied or unavailable.';
    
    if (err.name === 'NotAllowedError') {
      errorMsg = 'Camera access denied. Please enable camera permissions and try again.';
    } else if (err.name === 'NotFoundError') {
      errorMsg = 'No camera found. Please ensure your device has a camera and try again.';
    } else if (err.name === 'NotReadableError') {
      errorMsg = 'Camera is being used by another application. Please close other apps and try again.';
    } else if (err.name === 'OverconstrainedError') {
      errorMsg = 'Camera constraints not supported. Please try on a different device or browser.';
    }
    
    showPopup('Camera Error', errorMsg, false);
    return false;
  }
}
