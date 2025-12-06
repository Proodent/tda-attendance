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

if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !COMPREFACE_API_KEY || !COMPREFACE_URL || !PORT) {
  console.error("Missing required environment variables:", {
    SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, COMPREFACE_API_KEY, COMPREFACE_URL, PORT
  });
  process.exit(1);
}

const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: processedKey,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
async function loadDoc() { await doc.loadInfo(); }

// ----------------- Utility functions -----------------
function toRad(v) { return v * Math.PI / 180; }
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ----------------- API: Health -----------------
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    console.error("Health check error:", err);
    res.json({ success: false, error: err.message });
  }
});

// ----------------- API: Locations -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    if (!locSheet) return res.status(500).json({ error: "Locations Sheet not found" });
    const rows = await locSheet.getRows();

    const locations = rows.map(r => ({
      name: (r["Location Name"] || r.get("Location Name") || "").trim(),
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius (meters)") ?? r["Radius (Meters)"] ?? 150)
    })).filter(l => l.name && l.lat && l.long);

    console.log("Locations fetched:", locations.length, "records");
    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- API: Admin Logins -----------------
app.get("/api/admin-logins", async (req, res) => {
  try {
    await loadDoc();
    const adminSheet = doc.sheetsByTitle["Admin Logins"];
    if (!adminSheet) return res.status(500).json({ error: "Admin Logins sheet not found" });
    const rows = await adminSheet.getRows();

    const adminLogins = rows.map(r => [
      (r["Email"] || r.get("Email") || "").trim(),
      (r["Password"] || r.get("Password") || "").trim()
    ]).filter(row => row[0] && row[1]);

    console.log("Admin logins fetched:", adminLogins.length, "records");
    res.json({ success: true, logins: adminLogins });
  } catch (err) {
    console.error("GET /api/admin-logins error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- API: Staff by UserID (with allowedLocations) -----------------
app.post("/api/staff-by-id", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Staff Sheet"];
    if (!sheet) return res.status(404).json({ success: false, message: "Staff Sheet not found" });

    const rows = await sheet.getRows();
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "UserID required" });

    const userIdStr = userId.toString().trim();
    const staff = rows.find(r => {
      const id = (r["UserID"] || r.get("UserID") || "").toString().trim();
      return id === userIdStr;
    });

    if (!staff) return res.status(404).json({ success: false, message: "User not found" });

    const name = (staff["Name"] || staff.get("Name") || "").trim();
    const active = (staff["Active"] || staff.get("Active") || "No").toString().trim();
    const allowed = (staff["Allowed Locations"] || staff.get("Allowed Locations") || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    res.json({
      success: true,
      staff: { name, active, allowedLocations: allowed }
    });
  } catch (err) {
    console.error("POST /api/staff-by-id error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------- Proxy: CompreFace -----------------
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
    return res.json(data);
  } catch (err) {
    console.error("POST /api/proxy/face-recognition error:", err);
    res.status(500).json({ success: false, error: "CompreFace proxy error", details: err.message });
  }
});

// ----------------- Attendance Logging (CASE-INSENSITIVE LOCATION MATCH) -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, userId, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || !userId || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Missing or invalid input." });
    }

    await loadDoc();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    const userIdStr = userId.toString().trim();
    const staffMember = staffRows.find(r => {
      const id   = (r["UserID"] || r.get("UserID") || "").toString().trim();
      const name = (r["Name"]    || r.get("Name")    || "").trim();
      const act  = (r["Active"]  || r.get("Active")  || "No").toString().toLowerCase();
      return id === userIdStr && name === subjectName.trim() && act === "yes";
    });

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Invalid UserID or Name, or staff is inactive.` });
    }

    // ----- ALLOWED LOCATIONS (trimmed, lowercased) -----
    const allowedRaw = (staffMember["Allowed Locations"] || staffMember.get("Allowed Locations") || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    // ----- OFFICE LOCATIONS (from Locations Sheet) -----
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get("Location Name") || "").trim(),
      lat:  parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius (meters)") ?? r["Radius (Meters)"] ?? 150)
    })).filter(o => o.name && o.lat && o.long);

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), o.lat, o.long);
      if (distKm <= (o.radiusMeters / 1000)) {
        officeName = o.name; // Keep original case for display
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any registered office location." });
    }

    // ----- CASE-INSENSITIVE LOCATION CHECK -----
    if (!allowedRaw.includes(officeName.toLowerCase())) {
      return res.status(403).json({ success: false, message: `Unapproved Location – you are not allowed at "${officeName}".` });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0].slice(0, 8);

    const existing = attendanceRows.find(r =>
      (r["Date"] || r.get("Date")) === dateStr &&
      (r["Name"] || r.get("Name") || "").trim() === subjectName.trim()
    );

    if (action === "clock in") {
      if (existing && (existing["Time In"] || existing.get("Time In"))) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      const deptValue = staffMember["Department"] || staffMember.get("Department") || "";

      await attendanceSheet.addRow({
        "Date": dateStr,
        "Department": deptValue,
        "Name": subjectName,
        "UserID": userIdStr,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }
      if (existing["Time Out"] || existing.get("Time Out")) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      const headers = attendanceSheet.headerValues.map(h => h.trim().toLowerCase());
      const timeOutCol = headers.indexOf("time out");
      const clockOutLocCol = headers.indexOf("clock out location");

      if (timeOutCol === -1 || clockOutLocCol === -1) {
        return res.status(500).json({ success: false, message: "Missing Time Out or Clock Out Location columns." });
      }

      await attendanceSheet.loadCells();
      const rowIndex = existing._rowNumber - 1;
      
      const timeOutCell = attendanceSheet.getCell(rowIndex, timeOutCol);
      const locOutCell = attendanceSheet.getCell(rowIndex, clockOutLocCol);
      
      // Convert timeStr "14:34:24" into real time parts
      const [hh, mm, ss] = timeStr.split(":").map(Number);
      
      // Force Google Sheets to treat as TIME, not text
      timeOutCell.numberFormat = { type: "TIME" };
      timeOutCell.value = { hour: hh, minute: mm, second: ss };
      
      locOutCell.value = officeName;
      
      await attendanceSheet.saveUpdatedCells();


      // await attendanceSheet.loadCells();
      // const rowIndex = existing._rowNumber - 1;
      // const timeOutCell = attendanceSheet.getCell(rowIndex, timeOutCol);
      // const locOutCell = attendanceSheet.getCell(rowIndex, clockOutLocCol);
      // timeOutCell.value = timeStr;
      // locOutCell.value = officeName;
      // await attendanceSheet.saveUpdatedCells();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });
  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ----------------- API: Staff -----------------
app.get("/api/staff", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Staff Sheet"];
    if (!sheet) return res.status(404).json({ success: false, message: "Staff Sheet not found" });

    const rows = await sheet.getRows();
    const activeStaff = rows.filter(r =>
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    );
    const totalStaff = rows.length;

    res.json({
      success: true,
      totalStaff,
      staffCount: activeStaff.length,
      staff: activeStaff.map(r => ({
        name: r["Name"] || r.get("Name"),
        userId: r["UserID"] || r.get("UserID"),
        department: r["Department"] || r.get("Department"),
        active: true
      }))
    });
  } catch (err) {
    console.error("GET /api/staff error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------- API: Stats -----------------
app.get("/api/stats", async (req, res) => {
  try {
    await loadDoc();
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    if (!attendanceSheet || !staffSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    const attendanceRows = await attendanceSheet.getRows();
    const staffRows = await staffSheet.getRows();

    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    const requestedDate = req.query.date || yesterdayStr;

    const parseDate = str => new Date(str + "T00:00:00");
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const filterByRange = (rows, d1, d2) =>
      rows.filter(r => {
        const d = parseDate(r["Date"] || r.get("Date"));
        return d >= d1 && d <= d2;
      });

    const clockIns = {
      today: attendanceRows.filter(r => (r["Date"] || r.get("Date")) === requestedDate && (r["Time In"] || r.get("Time In"))).length,
      week: filterByRange(attendanceRows, startOfWeek, yesterday).filter(r => r["Time In"] || r.get("Time In")).length,
      month: filterByRange(attendanceRows, startOfMonth, yesterday).filter(r => r["Time In"] || r.get("Time In")).length
    };

    const clockOuts = {
      today: attendanceRows.filter(r => (r["Date"] || r.get("Date")) === requestedDate && (r["Time Out"] || r.get("Time Out"))).length,
      week: filterByRange(attendanceRows, startOfWeek, yesterday).filter(r => r["Time Out"] || r.get("Time Out")).length,
      month: filterByRange(attendanceRows, startOfMonth, yesterday).filter(r => r["Time Out"] || r.get("Time Out")).length
    };

    const activeStaff = staffRows.filter(r =>
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    ).length;
    const totalStaff = staffRows.length;

    const presentToday = clockIns.today;
    const absentToday = activeStaff > 0 ? Math.max(0, activeStaff - presentToday) : 0;
    const percentClockedIn = activeStaff > 0 ? Math.round((presentToday / activeStaff) * 100) : 0;
    const percentClockedOut = presentToday > 0 ? Math.round((clockOuts.today / presentToday) * 100) : 0;

    const staffAttendance = attendanceRows
      .filter(r => (r["Date"] || r.get("Date")) === requestedDate)
      .map(r => ({
        userId: r["UserID"] || r.get("UserID") || "",
        name: r["Name"] || r.get("Name") || "",
        department: r["Department"] || r.get("Department") || "",
        timeIn: r["Time In"] || r.get("Time In") || "",
        timeOut: r["Time Out"] || r.get("Time Out") || "",
        clockInLocation: r["Clock In Location"] || r.get("Clock In Location") || "Unknown",
        clockOutLocation: r["Clock Out Location"] || r.get("Clock Out Location") || "Unknown"
      }));

    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      const count = attendanceRows.filter(r =>
        (r["Date"] || r.get("Date")) === dateStr && (r["Time In"] || r.get("Time In"))
      ).length;
      trend.push({
        date: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        present: count
      });
    }

    res.json({
      success: true,
      totalStaff,
      activeStaff,
      clockIns,
      clockOuts,
      presentToday,
      absentToday,
      percentClockedIn,
      percentClockedOut,
      trend,
      staffAttendance,
      selectedDate: requestedDate
    });
  } catch (err) {
    console.error("GET /api/stats error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------- Static Frontend -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));
app.get("/stats", (req, res) => res.sendFile(path.join(__dirname, "stats.html")));

// ----------------- Start Server -----------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () =>
  console.log(`Proodent Attendance API running on port ${listenPort}`)
);

