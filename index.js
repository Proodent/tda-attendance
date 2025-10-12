// index.js — Proodent Attendance System Server
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

if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("❌ Missing Google Sheets config in .env file!");
}

// ----------------- Google Sheets Setup -----------------
const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// Load document safely
async function loadDoc() {
  await doc.loadInfo();
}

// ----------------- HEALTH CHECK -----------------
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "✅ Google Sheets connected successfully!" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ----------------- LOCATIONS -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    if (!locSheet) return res.status(500).json({ error: "Locations Sheet not found" });
    const rows = await locSheet.getRows();

    const locations = rows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"] ?? 0),
      long: parseFloat(r["Longitude"] ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r["Radius (Meters)"] ?? 150)
    }));

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- FACE RECOGNITION PROXY -----------------
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
    console.error("POST /api/proxy/face-recognition error:", err);
    res.status(500).json({ success: false, error: "CompreFace proxy error", details: err.message });
  }
});

// ----------------- ATTENDANCE -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || isNaN(latitude) || isNaN(longitude) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid input." });
    }

    await loadDoc();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Missing required sheet(s)." });
    }

    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    // ✅ Identify staff
    const staffMember = staffRows.find(r =>
      (r["Name"] || "").trim().toLowerCase() === subjectName.trim().toLowerCase() &&
      (r["Active"] || "").trim().toLowerCase() === "yes"
    );

    if (!staffMember) {
      return res.json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });
    }

    // ✅ Distance calculation
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || "").toString(),
      lat: parseFloat(r["Latitude"] ?? 0),
      long: parseFloat(r["Longitude"] ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r["Radius (Meters)"] ?? 150)
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

    let officeName = null;
    for (const loc of officeLocations) {
      const distKm = getDistanceKm(latitude, longitude, loc.lat, loc.long);
      if (distKm <= loc.radiusMeters / 1000) {
        officeName = loc.name;
        break;
      }
    }

    if (!officeName) {
      return res.json({ success: false, message: "Unapproved Location" });
    }

    // ✅ Check allowed locations
    const allowedRaw = (staffMember["Allowed Locations"] || "").split(",").map(s => s.trim());
    if (!allowedRaw.includes(officeName)) {
      return res.json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    // ✅ Prepare record
    const userId = (staffMember["User ID"] || "").toString().trim();
    const department = (staffMember["Department"] || "").toString().trim();
    const dateStr = new Date(timestamp).toISOString().split("T")[0];
    const timeStr = new Date(timestamp).toTimeString().split(" ")[0];

    const todayRecord = attendanceRows.find(r =>
      (r["Date"] || "").trim() === dateStr &&
      (r["User ID"] || "").trim() === userId
    );

    if (action === "clock in") {
      if (todayRecord && (todayRecord["Time In"] || "").trim() !== "") {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      if (!todayRecord) {
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
      } else {
        todayRecord["Time In"] = timeStr;
        todayRecord["Clock In Location"] = officeName;
        await todayRecord.save();
      }

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      if (!todayRecord) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in record found for today.` });
      }

      if ((todayRecord["Time Out"] || "").trim() !== "") {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      todayRecord["Time Out"] = timeStr;
      todayRecord["Clock Out Location"] = officeName;
      await todayRecord.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });

  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dev", (req, res) => {
  res.sendFile(path.join(__dirname, "developer.html"));
});

// ----------------- START SERVER -----------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => console.log(`✅ Proodent Attendance API running on port ${listenPort}`));
