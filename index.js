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
app.use(cors({
  origin: ["http://localhost:3000", "https://tolon-attendance.proodentit.com"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV
const {
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  COMPREFACE_API_KEY,
  COMPREFACE_URL,
  PORT
} = process.env;

if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !COMPREFACE_API_KEY || !COMPREFACE_URL || !PORT) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
let sheetCache = {};

// Load doc once
async function loadDoc() {
  if (!doc.title) await doc.loadInfo();
  return doc;
}

// Utility: Haversine distance
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Health Check
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "Connected to Google Sheets" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Locations
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Locations Sheet"];
    if (!sheet) return res.status(500).json({ error: "Locations Sheet not found" });

    const rows = await sheet.getRows();
    const locations = rows.map(r => ({
      name: r.get("Location Name") || "",
      lat: parseFloat(r.get("Latitude") || 0),
      long: parseFloat(r.get("Longitude") || 0),
      radiusMeters: parseFloat(r.get("Radius (meters)") || r.get("Radius") || 150)
    })).filter(l => l.name && l.lat && l.long);

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Logins
app.get("/api/admin-logins", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Admin Logins"];
    if (!sheet) return res.status(500).json({ error: "Admin Logins sheet not found" });

    const rows = await sheet.getRows();
    const logins = rows
      .map(r => [r.get("Email")?.trim(), r.get("Password")?.trim()])
      .filter(([e, p]) => e && p);

    res.json({ success: true, logins });
  } catch (err) {
    console.error("GET /api/admin-logins error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// CompreFace Proxy
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const url = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/recognize?limit=5`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Face recognition proxy error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Attendance Logging (Web)
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, department, latitude, longitude, timestamp, userId } = req.body;
    if (!action || !subjectName || !latitude || !longitude || !timestamp) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    await loadDoc();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Sheet not found" });
    }

    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    const staffMember = staffRows.find(r =>
      (r.get("Name") || "").trim().toLowerCase() === subjectName.trim().toLowerCase() &&
      (r.get("Active") || "").toLowerCase() === "yes"
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: "Staff not found or inactive" });
    }

    const allowedLocations = (staffMember.get("Allowed Locations") || "")
      .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

    const officeLocations = locRows.map(r => ({
      name: r.get("Location Name") || "",
      lat: parseFloat(r.get("Latitude") || 0),
      long: parseFloat(r.get("Longitude") || 0),
      radiusMeters: parseFloat(r.get("Radius (meters)") || 150)
    })).filter(l => l.name);

    let officeName = null;
    for (const loc of officeLocations) {
      const dist = getDistanceKm(latitude, longitude, loc.lat, loc.long);
      if (dist * 1000 <= loc.radiusMeters) {
        officeName = loc.name;
        break;
      }
    }

    if (!officeName || !allowedLocations.includes(officeName.toLowerCase())) {
      return res.status(403).json({ success: false, message: "Location not allowed" });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0].slice(0, 5);

    const existing = attendanceRows.find(r =>
      r.get("Date") === dateStr &&
      (r.get("Name") || "").trim().toLowerCase() === subjectName.toLowerCase()
    );

    if (action === "clock in") {
      if (existing?.get("Time In")) {
        return res.json({ success: false, message: `Already clocked in today` });
      }

      await attendanceSheet.addRow({
        "Date": dateStr,
        "Department": department || staffMember.get("Department") || "",
        "Name": subjectName,
        "UserID": userId || staffMember.get("UserID") || "",
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Clock-in recorded at ${timeStr} (${officeName})` });
    }

    if (action === "clock out") {
      if (!existing) return res.json({ success: false, message: "No clock-in found" });
      if (existing.get("Time Out")) return res.json({ success: false, message: "Already clocked out" });

      await attendanceSheet.loadCells();
      const row = existing._rowNumber - 1;
      const headers = attendanceSheet.headerValues.map(h => h.toLowerCase());
      const timeOutIdx = headers.indexOf("time out");
      const locOutIdx = headers.indexOf("clock out location");

      if (timeOutIdx === -1 || locOutIdx === -1) {
        return res.status(500).json({ success: false, message: "Missing columns" });
      }

      attendanceSheet.getCell(row, timeOutIdx).value = timeStr;
      attendanceSheet.getCell(row, locOutIdx).value = officeName;
      await attendanceSheet.saveUpdatedCells();

      return res.json({ success: true, message: `Clock-out recorded at ${timeStr} (${officeName})` });
    }

    res.status(400).json({ success: false, message: "Invalid action" });
  } catch (err) {
    console.error("Attendance error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Staff List
app.get("/api/staff", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Staff Sheet"];
    if (!sheet) return res.status(404).json({ error: "Staff Sheet not found" });

    const rows = await sheet.getRows();
    const active = rows.filter(r => (r.get("Active") || "").toLowerCase() === "yes");

    res.json({
      success: true,
      totalStaff: rows.length,
      staffCount: active.length,
      staff: active.map(r => ({
        userId: r.get("UserID") || "",
        name: r.get("Name") || "",
        department: r.get("Department") || "",
        active: true
      }))
    });
  } catch (err) {
    console.error("GET /api/staff error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stats Dashboard
app.get("/api/stats", async (req, res) => {
  try {
    await loadDoc();
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    if (!attendanceSheet || !staffSheet) {
      return res.status(500).json({ error: "Sheets not found" });
    }

    const [attendanceRows, staffRows] = await Promise.all([
      attendanceSheet.getRows(),
      staffSheet.getRows()
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const requestedDate = req.query.date || today.toISOString().split("T")[0];

    const activeStaffCount = staffRows.filter(r => (r.get("Active") || "").toLowerCase() === "yes").length;

    // Filter attendance for requested date
    const dayAttendance = attendanceRows.filter(r => r.get("Date") === requestedDate);

    const presentToday = dayAttendance.filter(r => r.get("Time In")).length;
    const absentToday = Math.max(0, activeStaffCount - presentToday);
    const percentIn = activeStaffCount ? Math.round((presentToday / activeStaffCount) * 100) : 0;
    const percentOut = presentToday ? Math.round((dayAttendance.filter(r => r.get("Time Out")).length / presentToday) * 100) : 0;

    const staffAttendance = dayAttendance.map(r => ({
      userId: r.get("UserID") || "",
      name: r.get("Name") || "",
      department: r.get("Department") || "",
      timeIn: r.get("Time In") || "",
      timeOut: r.get("Time Out") || "",
      clockInLocation: r.get("Clock In Location") || "Unknown"
    }));

    // 90-day trend
    const ninetyDaysAgo = new Date(today);
    ninetyDaysAgo.setDate(today.getDate() - 89);

    const trendMap = {};
    attendanceRows.forEach(r => {
      const date = r.get("Date");
      if (date && date >= ninetyDaysAgo.toISOString().split("T")[0] && date <= today.toISOString().split("T")[0]) {
        trendMap[date] = (trendMap[date] || 0) + (r.get("Time In") ? 1 : 0);
      }
    });

    const trend = Object.keys(trendMap).map(date => ({
      date,
      present: trendMap[date]
    })).sort((a, b) => a.date.localeCompare(b.date));

    // Weekly summary (last 12 weeks)
    const weeklyMap = {};
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay() - 83); // 12 weeks back

    attendanceRows.forEach(r => {
      const date = new Date(r.get("Date"));
      if (date >= startOfWeek && date <= today) {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const weekKey = weekStart.toISOString().split("T")[0];
        weeklyMap[weekKey] = (weeklyMap[weekKey] || 0) + (r.get("Time In") ? 1 : 0);
      }
    });

    const weeklyData = Object.keys(weeklyMap).map(week => {
      const end = new Date(week);
      end.setDate(end.getDate() + 6);
      return {
        week: `Week ${Math.ceil((new Date(week) - startOfWeek) / (7 * 24 * 60 * 60 * 1000))}`,
        startDate: week,
        endDate: end.toISOString().split("T")[0],
        totalPresent: weeklyMap[week]
      };
    }).sort((a, b) => a.startDate.localeCompare(b.startDate));

    res.json({
      success: true,
      totalStaff: staffRows.length,
      activeStaff: activeStaffCount,
      clockInsToday: presentToday,
      clockOutsToday: dayAttendance.filter(r => r.get("Time Out")).length,
      absentToday,
      percentClockedIn: percentIn,
      percentClockedOut: percentOut,
      staffAttendance,
      trend,
      weeklyData,
      selectedDate: requestedDate
    });
  } catch (err) {
    console.error("GET /api/stats error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve Frontend
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/stats", (req, res) => res.sendFile(path.join(__dirname, "stats.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

// Start Server
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => {
  console.log(`Proodent Attendance API running on http://localhost:${listenPort}`);
  console.log(`Dashboard: http://localhost:${listenPort}/stats`);
});
