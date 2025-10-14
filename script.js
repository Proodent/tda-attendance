let videoEl, popupEl, loaderEl, popupIcon, popupHeader, popupMessage, popupFooter;
let locations = [];
let watchId = null;

function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  loaderEl.querySelector("p").textContent = text;
  loaderEl.style.display = "flex";
}

function hideLoader() {
  loaderEl.style.display = "none";
}

function showPopup(title, message, type) {
  popupEl = document.getElementById("popup");
  popupIcon = document.getElementById("popupIcon");
  popupHeader = document.getElementById("popupHeader");
  popupMessage = document.getElementById("popupMessage");
  popupFooter = document.getElementById("popupFooter");

  popupIcon.innerHTML = type === "success" ? "✔️" : "❌";
  popupIcon.className = "popup-icon " + (type === "success" ? "success" : "error");
  popupHeader.textContent = title;
  popupMessage.textContent = message;
  popupFooter.textContent = new Date().toLocaleString();

  popupEl.classList.add("show");

  setTimeout(() => popupEl.classList.remove("show"), 5000);
}

async function fetchLocations() {
  try {
    const res = await fetch('/api/locations');
    const data = await res.json();
    if (!data.success) throw new Error('Invalid location data');
    locations = data.locations;
    return true;
  } catch {
    showPopup("Error", "Unable to load location data.", "error");
    return false;
  }
}

async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    videoEl = document.getElementById("video");
    videoEl.srcObject = stream;
    videoEl.style.transform = "scaleX(-1)";
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup("Camera Error", err.message, "error");
    return false;
  }
}

function stopVideo() {
  if (videoEl?.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
}

async function validateFace(base64) {
  try {
    const res = await fetch('/api/proxy/face-recognition', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({file: base64})
    });
    const j = await res.json();
    if (j?.result?.[0]?.subjects?.length) {
      const top = j.result[0].subjects[0];
      return {ok: true, subject: top.subject, similarity: Number(top.similarity)};
    }
    return {ok: false, error: "Face not recognized"};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

async function handleClock(action) {
  const locationEl = document.getElementById("location");
  const lat = Number(locationEl.dataset.lat);
  const lon = Number(locationEl.dataset.long);
  if (!lat || !lon) return showPopup("Location Error", "No GPS data available.", "error");

  document.getElementById("faceRecognition").style.display = "block";
  const started = await startVideo();
  if (!started) return;

  await new Promise(r => setTimeout(r, 1000));

  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL("image/jpeg").split(",")[1];
  stopVideo();
  document.getElementById("faceRecognition").style.display = "none";

  showLoader();
  const faceRes = await validateFace(base64);
  if (!faceRes.ok || (faceRes.similarity < 0.55)) {
    hideLoader();
    return showPopup("Verification Unsuccessful", faceRes.error || "Face not recognized.", "error");
  }

  try {
    const res = await fetch('/api/attendance/web', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action, subjectName: faceRes.subject, latitude: lat, longitude: lon})
    });
    const j = await res.json();
    hideLoader();

    if (j.success) {
      showPopup("Verification Successful", `Dear ${faceRes.subject}, ${action} successful.`, "success");
    } else if (j.message?.includes("denied")) {
      showPopup(`Clock ${action.includes("in") ? "In" : "Out"} Denied`, j.message, "error");
    } else if (j.message?.includes("location")) {
      showPopup("Unapproved Location", j.message, "error");
    } else {
      showPopup("Verification Unsuccessful", j.message || "Attendance not logged.", "error");
    }
  } catch (err) {
    hideLoader();
    showPopup("Server Error", err.message, "error");
  }
}

async function startLocationWatch() {
  const statusEl = document.getElementById("status");
  const locationEl = document.getElementById("location");
  const clockInBtn = document.getElementById("clockIn");
  const clockOutBtn = document.getElementById("clockOut");

  const ok = await fetchLocations();
  if (!ok) return;

  if (!navigator.geolocation) {
    statusEl.textContent = "Geolocation not supported.";
    return;
  }

  watchId = navigator.geolocation.watchPosition(pos => {
    const {latitude, longitude} = pos.coords;
    let office = null;
    for (const o of locations) {
      const dist = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (dist <= o.radiusMeters / 1000) office = o.name;
    }

    if (office) {
      statusEl.textContent = `You are currently at: ${office}`;
      locationEl.textContent = `Location: ${office}`;
      clockInBtn.disabled = clockOutBtn.disabled = false;
      locationEl.dataset.lat = latitude;
      locationEl.dataset.long = longitude;
    } else {
      statusEl.textContent = "Unapproved Location";
      clockInBtn.disabled = clockOutBtn.disabled = true;
    }
  });

  clockInBtn.onclick = () => handleClock("clock in");
  clockOutBtn.onclick = () => handleClock("clock out");
}

window.onload = startLocationWatch;
window.onunload = () => { if (watchId) navigator.geolocation.clearWatch(watchId); stopVideo(); };
