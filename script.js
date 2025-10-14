const clockInBtn = document.getElementById("clockIn");
const clockOutBtn = document.getElementById("clockOut");
const loaderOverlay = document.getElementById("loaderOverlay");

const popup = document.getElementById("popup");
const popupIcon = document.getElementById("popupIcon");
const popupHeader = document.getElementById("popupHeader");
const popupMessage = document.getElementById("popupMessage");
const popupFooter = document.getElementById("popupFooter");
const closeBtn = document.getElementById("closePopup");

clockInBtn.addEventListener("click", () => handleAttendance("in"));
clockOutBtn.addEventListener("click", () => handleAttendance("out"));

async function handleAttendance(type) {
  showLoader(true);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Simulate backend
  const response = await simulateBackend(type);
  showLoader(false);

  // Handle specific outcomes
  switch (response.status) {
    case "success":
      showPopup("success", "Verification Successful", `Clock ${type} successful.`);
      break;
    case "face_fail":
      showPopup("error", "Verification Unsuccessful", "Face not recognized. Try again.");
      break;
    case "denied":
      showPopup("error", `Clock ${type === "in" ? "In" : "Out"} Denied`, `You have already clocked ${type === "in" ? "in" : "out"}.`);
      break;
    case "location_fail":
      showPopup("error", "Unapproved Location", "You are not at the registered office.");
      break;
    default:
      showPopup("error", "Error", "Unexpected issue occurred.");
  }
}

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

function showLoader(show) {
  loaderOverlay.style.display = show ? "flex" : "none";
}

function showPopup(type, header, message) {
  popupIcon.innerHTML =
    type === "success"
      ? '<div class="popup-icon success">✔</div>'
      : '<div class="popup-icon error">✖</div>';

  popupHeader.textContent = header;
  popupMessage.textContent = message;
  popupFooter.textContent = new Date().toLocaleString();

  popup.style.display = "flex";

  setTimeout(() => {
    popup.style.display = "none";
  }, 5000);
}

closeBtn.addEventListener("click", () => {
  popup.style.display = "none";
});
