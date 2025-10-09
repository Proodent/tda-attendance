// script.js (front-end logic)
// Fetch locations from backend, geofence, open camera, call face proxy, call attendance API.

let watchId = null;
let video, popup, popupHeader, popupMessage, popupFooter, popupRetry;
let locations = [];
let popupTimeout = null;

// ---------- Helpers ----------
function toRad(v){ return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showPopup(title, message, retry=false){
  if (popupTimeout) clearTimeout(popupTimeout);
  popupHeader.textContent = title;
  popupMessage.textContent = message;
  popupFooter.textContent = new Date().toLocaleString();
  popupRetry.innerHTML = retry ? '<button onclick="window.location.reload()">Retry</button>' : '';
  popup.style.display = 'block';
  popupTimeout = setTimeout(()=> popup.style.display = 'none', retry ? 8000 : 5000);
}

async function loadLocations(){
  try {
    const r = await fetch('/api/locations');
    const j = await r.json();
    if (!j.success || !Array.isArray(j.locations)) throw new Error('Bad locations response');
    locations = j.locations.map(l => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters)
    }));
    console.log('Loaded locations:', locations);
    return true;
  } catch (err) {
    console.error('Error loading locations:', err);
    return false;
  }
}

// ---------- Location watch ----------
async function startLocationWatch(){
  const status = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const clockIn = document.getElementById('clockIn');
  const clockOut = document.getElementById('clockOut');

  video = document.getElementById('video');
  popup = document.getElementById('popup');
  popupHeader = document.getElementById('popupHeader');
  popupMessage = document.getElementById('popupMessage');
  popupFooter = document.getElementById('popupFooter');
  popupRetry = document.getElementById('popupRetry');

  const ok = await loadLocations();
  if (!ok) return showPopup('Error', 'Unable to load location data. Please reload.', true);

  if (!navigator.geolocation){
    status.textContent = 'Geolocation not supported by your browser.';
    clockIn.disabled = clockOut.disabled = true;
    return;
  }

  // Start watching position
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      locationEl.dataset.lat = latitude;
      locationEl.dataset.long = longitude;

      // determine office
      let office = null;
      for (const o of locations){
        const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
        if (distKm <= (o.radiusMeters/1000)){
          office = o.name;
          break;
        }
      }

      if (office) {
        status.textContent = `You are currently at: ${office}`;
        locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        clockIn.disabled = clockOut.disabled = false;
        clockIn.style.opacity = clockOut.style.opacity = '1';
      } else {
        status.textContent = `Unapproved Location`;
        locationEl.textContent = `Location: Unapproved\nGPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        clockIn.disabled = clockOut.disabled = true;
        clockIn.style.opacity = clockOut.style.opacity = '0.6';
      }
    },
    (err) => {
      status.textContent = `Error getting location: ${err.message}`;
      clockIn.disabled = clockOut.disabled = true;
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );

  document.getElementById('clockIn').addEventListener('click', ()=> handleClock('clock in'));
  document.getElementById('clockOut').addEventListener('click', ()=> handleClock('clock out'));
}

// ---------- Camera + face capture ----------
async function startVideo(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = stream;
    video.style.transform = 'scaleX(-1)';
    await video.play();
    return true;
  } catch (err) {
    console.error('Camera error', err);
    showPopup('Verification Unsuccessful', `Camera error: ${err.message}`, true);
    return false;
  }
}

function stopVideo(){
  if (video && video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

async function validateFaceWithProxy(base64Image){
  try {
    // send as { file: "<base64>" } because some CompreFace installations expect "file"
    const r = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64Image })
    });
    const j = await r.json();
    console.log('CompreFace proxy returned:', j);
    // result array format (example): j.result[0].subjects = [{subject: "Name", similarity: 0.99}, ...]
    if (j?.result?.length && j.result[0].subjects?.length) {
      const top = j.result[0].subjects[0];
      return { ok: true, subject: top.subject, similarity: Number(top.similarity) };
    }
    return { ok: false, error: 'No match' };
  } catch (err) {
    console.error('Face proxy error', err);
    return { ok: false, error: err.message || 'Face API error' };
  }
}

// ---------- Handle clock ----------
async function handleClock(action){
  const status = document.getElementById('status');
  const locationEl = document.getElementById('location');
  const lat = Number(locationEl.dataset.lat);
  const long = Number(locationEl.dataset.long);
  if (!lat || !long) return showPopup('Location Error', 'Unable to detect GPS coordinates.', true);

  // show camera UI
  document.getElementById('faceRecognition').style.display = 'block';
  const started = await startVideo();
  if (!started) return;

  // capture one frame after a short delay
  await new Promise(r => setTimeout(r, 800));
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  // mirror correction
  ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg').split(',')[1];

  stopVideo();
  document.getElementById('faceRecognition').style.display = 'none';

  // validate face
  const faceRes = await validateFaceWithProxy(base64);
  if (!faceRes.ok) {
    return showPopup('Verification Unsuccessful', faceRes.error || 'No matching face found', true);
  }

  // Optional: enforce a similarity threshold on frontend too
  if (faceRes.similarity < 0.6) {
    return showPopup('Verification Unsuccessful', `Low similarity (${(faceRes.similarity*100).toFixed(0)}%).`, true);
  }

  // call backend attendance endpoint
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
    if (j.success) {
      showPopup('Verification Successful', j.message || `Dear ${faceRes.subject}, ${action} successful.`);
    } else {
      showPopup('Verification Unsuccessful', j.message || 'Attendance not logged.', true);
    }
  } catch (err) {
    console.error('Attendance API error', err);
    showPopup('Server Error', `Failed to log attendance: ${err.message}`, true);
  }
}

// ---------- Init ----------
window.onload = startLocationWatch;
window.onunload = () => { if (watchId) navigator.geolocation.clearWatch(watchId); stopVideo(); };
