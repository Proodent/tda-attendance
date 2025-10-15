// =============================
// index.js — Proodent Attendance System Server
// =============================
import express from "express";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

// ----------------- Setup -----------------
dotenv.config();
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(cors());

// ----------------- Fix __dirname for ES modules -----------------
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

// ----------------- Google Sheets Auth -----------------
const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

async function loadDoc() {
  try {
    await doc.loadInfo();
  } catch (err) {
    console.error("❌ Google Sheets load error:", err.message);
    throw new Error("Unable to connect to Google Sheets.");
  }
}

// ----------------- Utility -----------------
function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// =============================
// 🔹 Health Check
// =============================
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "✅ Google Sheets connected successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "❌ Google Sheets connection failed", error: err.message });
  }
});

// =============================
// 🔹 Office Locations
// =============================
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    if (!locSheet) throw new Error("Locations Sheet not found.");

    const rows = await locSheet.getRows();

    const locations = rows.map(r => ({
      name: r["Location Name"] || r.get("Location Name") || "",
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius (m)"] ?? r["Radius"] ?? 150)
    }));

    res.json({ success: true, locations });
  } catch (err) {
    console.error("❌ /api/locations error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================
// 🔹 Proxy — CompreFace
// =============================
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const payload = req.body;
    const url = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/recognize?limit=5`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.json(data);
    } catch {
      console.error("❌ Invalid JSON from CompreFace:", text.slice(0, 100));
      res.status(500).json({ success: false, message: "Invalid JSON from CompreFace" });
    }
  } catch (err) {
    console.error("❌ /api/proxy/face-recognition error:", err.message);
    res.status(500).json({ success: false, message: "CompreFace proxy error", error: err.message });
  }
});

// =============================
// 🔹 Attendance Logging
// =============================
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, department, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || !latitude || !longitude || !timestamp)
      return res.status(400).json({ success: false, message: "Invalid input fields." });

    await loadDoc();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet)
      throw new Error("One or more sheets missing.");

    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    // Find staff
    const staffMember = staffRows.find(r =>
      (r["Name"] || r.get("Name") || "").trim().toLowerCase() === subjectName.trim().toLowerCase() &&
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    );

    if (!staffMember)
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });

    // Allowed locations
    const allowedList = (staffMember["Allowed Locations"] || staffMember.get("Allowed Locations") || "")
      .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

    // Detect actual office
    const officeLocations = locRows.map(r => ({
      name: r["Location Name"] || r.get("Location Name"),
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius (m)"] ?? r["Radius"] ?? 150)
    }));

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(latitude, longitude, o.lat, o.long);
      if (distKm <= o.radiusMeters / 1000) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName)
      return res.status(403).json({ success: false, message: "Not inside any registered office location." });

    if (!allowedList.includes(officeName.trim().toLowerCase()))
      return res.status(403).json({ success: false, message: "Unapproved Location." });

    // Date-time
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    const existing = attendanceRows.find(r =>
      (r["Date"] || r.get("Date")) === dateStr &&
      (r["Name"] || r.get("Name")).trim().toLowerCase() === subjectName.trim().toLowerCase()
    );

    // Clock In
    if (action === "clock in") {
      if (existing && (existing["Time In"] || existing.get("Time In")))
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });

    await attendanceSheet.addRow({
        Date: dateStr,
        Department: department || staffMember["Department"] || staffMember.get("Department"),
        Name: subjectName,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Clock-in recorded for ${subjectName} at ${officeName}.` });
    }

    // Clock Out
    if (action === "clock out") {
      if (!existing)
        return res.json({ success: false, message: `No clock-in found for today.` });

      if (existing["Time Out"] || existing.get("Time Out"))
        return res.json({ success: false, message: `You already clocked out today.` });

      await attendanceSheet.loadCells();
      const headers = attendanceSheet.headerValues.map(h => h.toLowerCase());
      const rowIndex = existing._rowNumber - 1;
      const timeOutCol = headers.indexOf("time out");
      const locCol = headers.indexOf("clock out location");

      attendanceSheet.getCell(rowIndex, timeOutCol).value = timeStr;
      attendanceSheet.getCell(rowIndex, locCol).value = officeName;
      await attendanceSheet.saveUpdatedCells();

      return res.json({ success: true, message: `Clock-out recorded for ${subjectName} at ${officeName}.` });
    }

    res.status(400).json({ success: false, message: "Unknown action type." });
  } catch (err) {
    console.error("❌ /api/attendance/web error:", err.message);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// =============================
// 🔹 Attendance Stats + Active Staff
// =============================
app.get("/api/stats", async (req, res) => {
  try {
    await loadDoc();
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];

    if (!attendanceSheet || !staffSheet)
      throw new Error("Sheet(s) not found.");

    const [attendanceRows, staffRows] = await Promise.all([
      attendanceSheet.getRows(),
      staffSheet.getRows()
    ]);

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const inRange = (d, start) => {
      const date = new Date(d);
      return date >= start && date <= today;
    };

    const activeStaff = staffRows.filter(r => (r["Active"] || r.get("Active") || "").toLowerCase() === "yes");

    const totalStaff = activeStaff.length;
    const clockInsToday = attendanceRows.filter(r => (r["Date"] || r.get("Date")) === todayStr && (r["Time In"] || r.get("Time In"))).length;
    const clockOutsToday = attendanceRows.filter(r => (r["Date"] || r.get("Date")) === todayStr && (r["Time Out"] || r.get("Time Out"))).length;

    const clockInsWeek = attendanceRows.filter(r => inRange(r["Date"] || r.get("Date"), startOfWeek) && (r["Time In"] || r.get("Time In"))).length;
    const clockInsMonth = attendanceRows.filter(r => inRange(r["Date"] || r.get("Date"), startOfMonth) && (r["Time In"] || r.get("Time In"))).length;

    res.json({
      success: true,
      activeStaff: activeStaff.map(r => r["Name"] || r.get("Name")),
      totalStaff,
      clockIns: { today: clockInsToday, week: clockInsWeek, month: clockInsMonth },
      clockOutsToday,
      percentClockedIn: totalStaff ? Math.round((clockInsToday / totalStaff) * 100) : 0
    });
  } catch (err) {
    console.error("❌ /api/stats error:", err.message);
    res.status(500).json({ success: false, message: "Error fetching stats", error: err.message });
  }
});

// =============================
// 🔹 Static Frontend
// =============================
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

// =============================
// 🔹 Start Server
// =============================
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () =>
  console.log(`✅ Proodent Attendance API running on port ${listenPort}`)
);
