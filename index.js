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
      name: r["Location Name"] || r.get("Location Name") || "",
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius") ?? r["Radius (Meters)"] ?? 150)
    }));

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
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

// ----------------- Attendance Logging -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, department, latitude, longitude, timestamp } = req.body;
    if (!action || !subjectName || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid input." });
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

    const staffMember = staffRows.find(r =>
      (r["Name"] || r.get("Name") || "").trim().toLowerCase() === subjectName.trim().toLowerCase() &&
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });
    }

    const allowedList = (staffMember["Allowed Locations"] || staffMember.get("Allowed Locations") || "")
      .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get("Location Name") || "").toString(),
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius") ?? r["Radius (Meters)"] ?? 150)
    }));

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (o.radiusMeters / 1000)) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any registered office location." });
    }

    if (!allowedList.includes(officeName.trim().toLowerCase())) {
      return res.status(403).json({ success: false, message: "Unapproved Location." });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    const existing = attendanceRows.find(r =>
      (r["Date"] || r.get("Date")) === dateStr &&
      (r["Name"] || r.get("Name") || "").trim().toLowerCase() === subjectName.trim().toLowerCase()
    );

    if (action === "clock in") {
      if (existing && (existing["Time In"] || existing.get("Time In"))) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      const deptValue = department || staffMember["Department"] || staffMember.get("Department") || "";

      await attendanceSheet.addRow({
        "Date": dateStr,
        "Department": deptValue,
        "Name": subjectName,
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
      attendanceSheet.getCell(rowIndex, timeOutCol).value = timeStr;
      attendanceSheet.getCell(rowIndex, clockOutLocCol).value = officeName;
      await attendanceSheet.saveUpdatedCells();

      console.log(`✅ Clock-out updated for ${subjectName} on ${dateStr} (${officeName})`);
      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });
  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ----------------- NEW: Staff List -----------------
app.get("/api/staff", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Staff Sheet"];
    if (!sheet) return res.status(404).json({ success: false, message: "Staff Sheet not found" });

    const rows = await sheet.getRows();
    const activeStaff = rows.filter(r =>
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    );

    res.json({
      success: true,
      staffCount: activeStaff.length,
      staff: activeStaff.map(r => ({
        name: r["Name"] || r.get("Name"),
        department: r["Department"] || r.get("Department"),
        active: true
      }))
    });
  } catch (err) {
    console.error("GET /api/staff error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------- NEW: Attendance Stats -----------------
app.get("/api/stats", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Attendance Sheet"];
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    if (!sheet) return res.status(404).json({ success: false, message: "Attendance Sheet not found" });

    const [rows, staffRows] = await Promise.all([sheet.getRows(), staffSheet.getRows()]);

    const today = new Date().toISOString().split("T")[0];
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const parseDate = str => new Date(str + "T00:00:00");

    const filterByRange = (d1, d2) =>
      rows.filter(r => {
        const d = parseDate(r["Date"] || r.get("Date"));
        return d >= d1 && d <= d2;
      });

    const clockInsToday = rows.filter(r => (r["Date"] || r.get("Date")) === today && (r["Time In"] || r.get("Time In"))).length;
    const clockOutsToday = rows.filter(r => (r["Date"] || r.get("Date")) === today && (r["Time Out"] || r.get("Time Out"))).length;

    const clockInsWeek = filterByRange(startOfWeek, new Date()).length;
    const clockInsMonth = filterByRange(startOfMonth, new Date()).length;

    const activeStaff = staffRows.filter(r =>
      (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes"
    ).length;

    const percentClockedIn = activeStaff > 0 ? Math.round((clockInsToday / activeStaff) * 100) : 0;
    const percentClockedOut = activeStaff > 0 ? Math.round((clockOutsToday / activeStaff) * 100) : 0;

    res.json({
      success: true,
      clockIns: { today: clockInsToday, week: clockInsWeek, month: clockInsMonth },
      clockOuts: { today: clockOutsToday, week: clockInsWeek, month: clockInsMonth },
      activeStaff,
      percentClockedIn,
      percentClockedOut
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

// ----------------- Start Server -----------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () =>
  console.log(`✅ Proodent Attendance API running on port ${listenPort}`)
);
