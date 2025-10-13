// index.js — Proodent Attendance System Server (Fixed version)
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

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- ENV -----------------
const {
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  COMPREFACE_API_KEY,
  COMPREFACE_URL,
  PORT
} = process.env;

const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

async function loadDoc() {
  await doc.loadInfo();
}

// ----------------- API: Health -----------------
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ----------------- API: Locations -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    const rows = await locSheet.getRows();

    const locations = rows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"]) || 0,
      long: parseFloat(r["Longitude"]) || 0,
      radiusMeters: parseFloat(r["Radius (Meters)"] || r["Radius"] || 150)
    }));

    res.json({ success: true, locations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- Proxy CompreFace -----------------
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
    console.error("Face recognition error:", err);
    res.status(500).json({ success: false, error: "CompreFace proxy error", details: err.message });
  }
});

// ----------------- Attendance logging -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || !latitude || !longitude) {
      return res.status(400).json({ success: false, message: "Invalid input." });
    }

    await loadDoc();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locSheet = doc.sheetsByTitle["Locations Sheet"];

    const staffRows = await staffSheet.getRows();
    const attendanceRows = await attendanceSheet.getRows();
    const locRows = await locSheet.getRows();

    // ✅ Fix 1: Match staff by Name (trimmed & case-insensitive)
    const staffMember = staffRows.find(r =>
      (r["Name"] || "").toString().trim().toLowerCase() === subjectName.toLowerCase().trim()
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `No active staff found for ${subjectName}.` });
    }

    const userId = (staffMember["User ID"] || "").toString().trim();
    const department = (staffMember["Department"] || "").toString().trim();

    // ✅ Fix 2: Distance + allowed location
    function toRad(v) { return (v * Math.PI) / 180; }
    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"]) || 0,
      long: parseFloat(r["Longitude"]) || 0,
      radiusMeters: parseFloat(r["Radius (Meters)"] || r["Radius"] || 150)
    }));

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (distKm <= o.radiusMeters / 1000) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Unapproved Location" });
    }

    const allowedRaw = (staffMember["Allowed Locations"] || "").toString();
    const allowed = allowedRaw.split(",").map(x => x.trim());
    if (!allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    // ✅ Fix 3: Correctly match by Date + User ID
    const todayRow = attendanceRows.find(r =>
      (r["Date"] || "").toString() === dateStr &&
      (r["User ID"] || "").toString() === userId
    );

    if (action === "clock in") {
      if (todayRow && (todayRow["Time In"] || "").trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you already clocked in today.` });
      }

      await attendanceSheet.addRow({
        "User ID": userId,
        "Name": subjectName,
        "Department": department,
        "Date": dateStr,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      if (!todayRow) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in record found for today.` });
      }
      if (todayRow["Time Out"] && todayRow["Time Out"].trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you already clocked out today.` });
      }

      todayRow["Time Out"] = timeStr;
      todayRow["Clock Out Location"] = officeName;
      await todayRow.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    res.status(400).json({ success: false, message: "Invalid action type." });

  } catch (err) {
    console.error("Attendance error:", err);
    res.status(500).json({ success: false, message: "Server error", details: err.message });
  }
});

// ----------------- Static Frontend -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => console.log(`✅ Proodent Attendance API running on port ${listenPort}`));
