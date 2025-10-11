// index.js — Proodent Attendance System Server (Final Fixed Version)
import express from "express";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(cors());

// --- Fix __dirname for ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV ---
const {
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  COMPREFACE_API_KEY,
  COMPREFACE_URL,
  PORT
} = process.env;

if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("❌ Missing Google Sheets configuration in .env file!");
}

const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

async function loadDoc() {
  if (!doc._info) await doc.loadInfo();
}

// ------------------ HEALTH ------------------
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ------------------ LOCATIONS ------------------
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Locations Sheet"];
    if (!sheet) return res.status(500).json({ success: false, error: "Locations Sheet not found" });
    const rows = await sheet.getRows();

    const locations = rows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"]) || 0,
      long: parseFloat(r["Longitude"]) || 0,
      radiusMeters: parseFloat(r["Radius (Meters)"] || r["Radius"]) || 150
    }));

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------ COMPRE-FACE PROXY ------------------
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const payload = req.body || {};
    const url = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/recognize?limit=5`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("CompreFace Proxy Error:", err);
    res.status(500).json({ success: false, error: "CompreFace proxy error", details: err.message });
  }
});

// ------------------ ATTENDANCE ------------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || !latitude || !longitude || !timestamp)
      return res.status(400).json({ success: false, message: "Invalid request." });

    await loadDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationSheet)
      return res.status(500).json({ success: false, message: "Required sheet not found." });

    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationSheet.getRows()
    ]);

    // Find staff
    const staff = staffRows.find(r =>
      (r["Name"] || "").trim().toLowerCase() === subjectName.trim().toLowerCase()
    );

    if (!staff)
      return res.status(404).json({ success: false, message: `Staff '${subjectName}' not found.` });

    if ((staff["Active"] || "").toString().trim().toLowerCase() !== "yes")
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' is inactive.` });

    const userId = (staff["User ID"] || "").toString();
    const department = (staff["Department"] || "").toString();

    // --- Check location proximity ---
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"]) || 0,
      long: parseFloat(r["Longitude"]) || 0,
      radiusMeters: parseFloat(r["Radius (Meters)"] || r["Radius"]) || 150
    }));

    function toRad(v) { return v * Math.PI / 180; }
    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    let currentOffice = null;
    for (const o of officeLocations) {
      const dist = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (dist <= (o.radiusMeters / 1000)) {
        currentOffice = o.name;
        break;
      }
    }

    if (!currentOffice)
      return res.status(403).json({ success: false, message: "You are outside all approved locations." });

    // --- Validate allowed locations ---
    const allowedRaw = (staff["Allowed Locations"] || "").toString();
    const allowedList = allowedRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowedList.includes(currentOffice))
      return res.status(403).json({ success: false, message: `You are not allowed to ${action} at ${currentOffice}.` });

    // --- Prepare date/time ---
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    // --- Handle clock in ---
    if (action === "clock in") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || "").trim() === dateStr && (r["User ID"] || "").trim() === userId.trim()
      );

      if (existing && (existing["Time In"] || "").trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      await attendanceSheet.addRow({
        "User ID": userId,
        "Name": subjectName,
        "Department": department,
        "Date": dateStr,
        "Time In": timeStr,
        "Clock In Location": currentOffice,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${currentOffice}).` });
    }

    // --- Handle clock out ---
    if (action === "clock out") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || "").trim() === dateStr && (r["User ID"] || "").trim() === userId.trim()
      );

      if (!existing)
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });

      if ((existing["Time Out"] || "").trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = currentOffice;
      await existing.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${currentOffice}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });

  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ------------------ STATIC FRONTEND ------------------
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/dev", (req, res) => {
  res.sendFile(path.join(__dirname, "developer.html"));
});

// ------------------ START ------------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => {
  console.log(`✅ Proodent Attendance API running on port ${listenPort}`);
});
