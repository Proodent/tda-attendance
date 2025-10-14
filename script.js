const loader = document.getElementById("loader");
const popup = document.getElementById("popup");
const popupIcon = document.getElementById("popupIcon");
const popupTitle = document.getElementById("popupTitle");
const popupMessage = document.getElementById("popupMessage");

const clockInBtn = document.getElementById("clockInBtn");
const clockOutBtn = document.getElementById("clockOutBtn");

clockInBtn.addEventListener("click", () => handleAttendance("in"));
clockOutBtn.addEventListener("click", () => handleAttendance("out"));

async function handleAttendance(type) {
  showLoader(true);

  try {
    // Simulated delay for testing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Simulated backend response (replace with your fetch call)
    const response = await simulateBackend(type);

    showLoader(false);

    // ✅ Handle various outcomes
    if (response.status === "success") {
      showPopup("Verification Successful", `Clock ${type} successful.`, "success");
    } else if (response.status === "face_fail") {
      showPopup("Verification Unsuccessful", "Face not recognized. Try again.", "error");
    } else if (response.status === "denied") {
      showPopup("Clock " + (type === "in" ? "In" : "Out") + " Denied",
                `You have already clocked ${type === "in" ? "in" : "out"}.`,
                "error");
    } else if (response.status === "location_fail") {
      showPopup("Unapproved Location", "You are not at the registered office.", "error");
    } else {
      showPopup("Error", "Unexpected issue occurred.", "error");
    }

  } catch (err) {
    showLoader(false);
    showPopup("Error", "Unable to verify attendance.", "error");
  }
}

// 🔧 Simulated backend response for testing
function simulateBackend(type) {
  const results = [
    { status: "success" },
    { status: "face_fail" },
    { status: "denied" },
    { status: "location_fail" }
  ];
  const random = Math.floor(Math.random() * results.length);
  return Promise.resolve(results[random]);
}

// Loader toggle
function showLoader(show) {
  loader.classList.toggle("hidden", !show);
}

// Popup
function showPopup(title, message, type) {
  if (!popup) return;

  popupTitle.textContent = title;
  popupMessage.textContent = message;

  if (type === "success") {
    popupIcon.textContent = "✔️";
    popupIcon.style.color = "#009245";
    popup.style.borderTop = "5px solid #009245";
  } else {
    popupIcon.textContent = "❌";
    popupIcon.style.color = "#d32f2f";
    popup.style.borderTop = "5px solid #d32f2f";
  }

  popup.classList.remove("hidden");
  popup.classList.add("show");

  // Auto close after 5 seconds
  setTimeout(() => {
    popup.classList.remove("show");
    popup.classList.add("hidden");
  }, 5000);
}
