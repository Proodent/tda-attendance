// script.js – Tolon Attendance Front-End
let watchId = null,
  videoEl,
  canvasEl,
  popupEl,
  popupHeader,
  popupMessage,
  popupFooter,
  popupRetry,
  loaderEl;

let locations = [],
  popupTimeout = null,
  locationErrorShown = false;

let currentStaffId = null,
  currentStaffName = null;

// ---------- Utility ----------
function toRad(v) {
  return v * Math.PI / 180;
}
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1),
    dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------- Popup ----------
function showPopup(title, message, success = null) {
  if (!popupEl) return alert(`${title}\n\n${message}`);

  if (popupTimeout) clearTimeout(popupTimeout);

  popupHeader.textContent = title;
  popupHeader.className = "popup-header";
  if (success === true) popupHeader.classList.add("success");
  else if (success === false) popupHeader.classList.add("error");

  popupMessage.innerHTML = message;
  if (success === true)
    popupMessage.innerHTML +=
      '<div class="popup-icon success">Success</div>';
  else if (success === false)
    popupMessage.innerHTML += '<div class="popup-icon error">Error</div>';

  popupFooter.textContent = new Date().toLocaleString("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  popupRetry.innerHTML =
    '<button id="popupCloseBtn" class="popup-close-btn">Close</button>';

  popupEl.style.display = "flex";
  popupEl.classList.add("show");

  popupTimeout = setTimeout(() => {
    popupEl.classList.remove("show");
    popupEl.style.display = "none";
    if (title === "Location Error" && success === false)
      locationErrorShown = true;
  }, 5000);

  document.getElementById("popupCloseBtn").onclick = () => {
    popupEl.classList.remove("show");
    popupEl.style.display = "none";
    if (title === "Location Error" && success === false)
      locationErrorShown = true;
  };
}

// ---------- Loader ----------
function showLoader(text = "Verifying...") {
  loaderEl = document.getElementById("loaderOverlay");
  if (loaderEl) {
    loaderEl.querySelector("p").textContent = text;
    loaderEl.style.display = "flex";
  }
}
function hideLoader() {
  if (loaderEl) loaderEl.style.display = "none";
}

// ---------- Locations ----------
async function fetchLocations() {
  try {
    showLoader("Loading locations...");
    const res = await fetch("/api/locations", { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.locations))
      throw new Error("Invalid data");
    locations = data.locations.map((l) => ({
      name: l.name,
      lat: Number(l.lat),
      long: Number(l.long),
      radiusMeters: Number(l.radiusMeters),
    }));
    hideLoader();
    return true;
  } catch (e) {
    hideLoader();
    showPopup(
      "Location Error",
      `Failed to load locations: ${e.message}`,
      false
    );
    return false;
  }
}

// ---------- Geolocation ----------
function startLocationWatch() {
  const statusEl = document.getElementById("status"),
    locationEl = document.getElementById("location");
  const clockInBtn = document.getElementById("clockIn"),
    clockOutBtn = document.getElementById("clockOut");
  const staffIdInput = document.getElementById("staffId"),
    idError = document.getElementById("idError");

  videoEl = document.getElementById("video");
  canvasEl = document.getElementById("canvas");
  popupEl = document.getElementById("popup");
  popupHeader = document.getElementById("popupHeader");
  popupMessage = document.getElementById("popupMessage");
  popupFooter = document.getElementById("popupFooter");
  popupRetry = document.getElementById("popupRetry");

  fetchLocations().then((ok) => {
    if (!ok) {
      statusEl.textContent = "Location load failed.";
      clockInBtn.disabled = clockOutBtn.disabled = true;
      return;
    }

    if (!navigator.geolocation) {
      statusEl.textContent = "Geolocation not supported.";
      clockInBtn.disabled = clockOutBtn.disabled = true;
      showPopup(
        "Geolocation Error",
        "Browser doesn’t support geolocation.",
        false
      );
      return;
    }

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        let office = null;
        for (const loc of locations) {
          if (
            getDistanceKm(
              latitude,
              longitude,
              loc.lat,
              loc.long
            ) <=
            loc.radiusMeters / 1000
          ) {
            office = loc.name;
            break;
          }
        }

        if (office) {
          statusEl.textContent = `${office}`;
          locationEl.textContent = `Location: ${office}\nGPS: ${latitude.toFixed(
            6
          )}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude;
          locationEl.dataset.long = longitude;
          clockInBtn.disabled = clockOutBtn.disabled = !/^\d{3}$/.test(
            staffIdInput.value.trim()
          );
          locationErrorShown = false;
        } else if (!locationErrorShown) {
          statusEl.textContent = "Unapproved Location";
          locationEl.textContent = `Location: Unapproved\nGPS: ${latitude.toFixed(
            6
          )}, ${longitude.toFixed(6)}`;
          locationEl.dataset.lat = latitude;
          locationEl.dataset.long = longitude;
          clockInBtn.disabled = clockOutBtn.disabled = true;
          showPopup(
            "Location Error",
            "Not at an approved office.",
            false
          );
        }
      },
      (err) => {
        statusEl.textContent = `Location error: ${err.message}`;
        clockInBtn.disabled = clockOutBtn.disabled = true;
        if (!locationErrorShown)
          showPopup(
            "Location Error",
            `GPS failed: ${err.message}`,
            false
          );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    const updateButtons = () => {
      const valid = /^\d{3}$/.test(staffIdInput.value.trim());
      clockInBtn.disabled = clockOutBtn.disabled = !valid;
      idError.textContent = valid ? "" : "Enter 3 digits";
    };
    staffIdInput.addEventListener("input", updateButtons);
    updateButtons();

    clockInBtn.addEventListener("click", () => handleClock("clock in"));
    clockOutBtn.addEventListener("click", () => handleClock("clock out"));

    document
      .getElementById("adminDashboard")
      .addEventListener("click", () => {
        const adminPopup = document.getElementById("adminPopup");
        if (adminPopup) {
          adminPopup.classList.add("show");
          document.getElementById("adminError").textContent = "";
          document.getElementById("adminEmail").value = "";
          document.getElementById("adminPassword").value = "";
        }
      });
  });
}

// ---------- Camera ----------
async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
    });
    videoEl.srcObject = stream;
    videoEl.style.transform = "scaleX(-1)";
    await videoEl.play();
    return true;
  } catch (err) {
    showPopup("Camera Error", `Access denied: ${err.message}`, false);
    return false;
  }
}
function stopVideo() {
  if (videoEl && videoEl.srcObject)
    videoEl.srcObject.getTracks().forEach((t) => t.stop());
}

// ---------- Face Recognition (EXACT ERRORS) ----------
async function validateFaceWithProxyTargeted(base64, targetSubject) {
  try {
    const res = await fetch("/api/proxy/face-recognition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: base64, subject: targetSubject }),
    });
    if (!res.ok)
      return { ok: false, error: `Service error: ${await res.text()}` };

    const data = await res.json();

    // No face / subject found in CompreFace
    if (!data?.result?.length || !data.result[0].subjects?.length)
      return { ok: false, noSubject: true };

    const match = data.result[0].subjects[0];

    // Subject mismatch → treat as not registered
    if (match.subject !== targetSubject)
      return { ok: false, noSubject: true };

    const similarity = Number(match.similarity) || 0;
    if (similarity < 0.9)
      return { ok: false, lowSimilarity: true, similarity };

    return { ok: true, similarity };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- Clock In / Out ----------
async function handleClock(action) {
  currentStaffId = document.getElementById("staffId").value.trim();
  if (!/^\d{3}$/.test(currentStaffId)) {
    showPopup("Invalid ID", "Enter your 3-digit ID.", false);
    return;
  }

  showLoader("Verifying ID...");
  let staffName, comprefaceSubject;
  try {
    const res = await fetch(`/api/staff/${currentStaffId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.success || !data.name) throw new Error("Not found");
    staffName = data.name;
    comprefaceSubject = data.comprefaceSubject;
  } catch (err) {
    hideLoader();
    showPopup(
      "ID Error",
      `ID ${currentStaffId} not found or inactive. Contact HR.`,
      false
    );
    return;
  }
  currentStaffName = staffName;
  hideLoader();

  // ---- Location check ----
  const locationEl = document.getElementById("location");
  const lat = Number(locationEl.dataset.lat),
    long = Number(locationEl.dataset.long);
  if (!lat || !long) {
    showPopup("Location Error", "No GPS data.", false);
    return;
  }
  let office = null;
  for (const loc of locations) {
    if (
      getDistanceKm(lat, long, loc.lat, loc.long) <=
      loc.radiusMeters / 1000
    ) {
      office = loc.name;
      break;
    }
  }
  if (!office) {
    showPopup("Location Error", "Not at an approved office.", false);
    return;
  }

  // ---- Face capture ----
  document.getElementById("faceRecognition").style.display = "block";
  if (!(await startVideo())) return;
  await new Promise((r) => setTimeout(r, 1000));

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = 640;
  tempCanvas.height = 480;
  const ctx = tempCanvas.getContext("2d");
  ctx.translate(tempCanvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, tempCanvas.width, tempCanvas.height);
  const base64 = tempCanvas.toDataURL("image/jpeg").split(",")[1];

  stopVideo();
  document.getElementById("faceRecognition").style.display = "none";

  // ---- Face verification (EXACT ERRORS) ----
  showLoader("Verifying face...");
  const faceRes = await validateFaceWithProxyTargeted(base64, comprefaceSubject);

  if (!faceRes.ok) {
    hideLoader();
    if (faceRes.noSubject) {
      showPopup(
        "Face Not Found",
        `Dear ${staffName}, your face has not been added. See HR.`,
        false
      );
    } else if (faceRes.lowSimilarity) {
      showPopup(
        "Face Similarity Too Low",
        `Similarity: ${(faceRes.similarity * 100).toFixed(
          1
        )}%. Try better lighting or position.`,
        false
      );
    } else {
      showPopup(
        "Face Error",
        faceRes.error || "Verification failed.",
        false
      );
    }
    return;
  }

  // ---- Submit attendance ----
  try {
    const res = await fetch("/api/attendance/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        subjectName: comprefaceSubject,
        latitude: lat,
        longitude: long,
        timestamp: new Date().toISOString(),
      }),
    });
    const data = await res.json();
    hideLoader();

    if (data.success) {
      showPopup("Verification Successful", data.message, true);
    } else {
      // Backend already returns exact messages (e.g., "Staff is Inactive")
      showPopup("Attendance Error", data.message || "Not logged.", false);
    }
  } catch (err) {
    hideLoader();
    showPopup(
      "Server Error",
      `Connection failed: ${err.message}`,
      false
    );
  }
}

// ---------- Admin Login ----------
async function fetchAdminLogins() {
  try {
    showLoader("Logging in...");
    const res = await fetch("/api/admin-logins", { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hideLoader();
    return data.success ? data.logins : [];
  } catch (e) {
    hideLoader();
    showPopup(
      "Admin Error",
      `Failed to fetch logins: ${e.message}`,
      false
    );
    return [];
  }
}
function loginAdmin() {
  const email = document.getElementById("adminEmail").value.trim(),
    password = document.getElementById("adminPassword").value.trim();
  const adminError = document.getElementById("adminError"),
    adminPopup = document.getElementById("adminPopup");

  if (!email || !password) {
    adminError.textContent = "Fill both fields.";
    return;
  }

  fetchAdminLogins().then((logins) => {
    const valid = logins.find((r) => r[0] === email && r[1] === password);
    if (valid) {
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("lastActivity", Date.now());
      adminPopup.classList.remove("show");
      window.location.href = "stats.html";
    } else {
      adminError.textContent = "Invalid email or password.";
    }
  });
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", () => {
  const adminPopup = document.getElementById("adminPopup");
  if (adminPopup)
    adminPopup.addEventListener("click", (e) => {
      if (e.target === adminPopup) adminPopup.classList.remove("show");
    });

  startLocationWatch();
  initSessionTimeout();
});

window.onunload = () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  stopVideo();
};

// ---------- Session Timeout ----------
function initSessionTimeout() {
  let timeoutId;
  const SESSION_TIMEOUT = 86400000; // 24 h

  const isLoggedIn = () => localStorage.getItem("isLoggedIn") === "true";
  const logout = () => {
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("lastActivity");
    clearTimeout(timeoutId);
    window.location.href = "index.html";
  };
  const resetTimeout = () => {
    const last = localStorage.getItem("lastActivity");
    if (last && Date.now() - parseInt(last, 10) >= SESSION_TIMEOUT) {
      logout();
      return;
    }
    localStorage.setItem("lastActivity", Date.now());
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      alert("Session expired.");
      logout();
    }, SESSION_TIMEOUT);
  };

  if (isLoggedIn() && window.location.pathname !== "/index.html") {
    localStorage.setItem("lastActivity", Date.now());
    resetTimeout();
    ["mousemove", "keypress", "click", "scroll"].forEach((ev) =>
      document.addEventListener(ev, resetTimeout)
    );
  }
}
