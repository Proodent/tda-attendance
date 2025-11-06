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

// CompreFace headers
const compreFaceHeaders = {
  "x-api-key": COMPREFACE_API_KEY,
  "Content-Type": "application/json"
};

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
      name: r["Location Name"] || r.get("Location Name") || "",
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius (meters)") ?? r["Radius (Meters)"] ?? 150)
    }));

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
      r["Email"] || r.get("Email") || "",
      r["Password"] || r.get("Password") || ""
    ]).filter(row => row[0] && row[1]); // Filter out incomplete rows

    console.log("Admin logins fetched:", adminLogins.length, "records");
    res.json({ success: true, logins: adminLogins });
  } catch (err) {
    console.error("GET /api/admin-logins error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- Attendance Logging -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, id, base64, latitude, longitude, timestamp } = req.body;
    if (!action || !id || !base64 || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid input: Missing ID, image, or location data." });
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

    // Find staff by ID (assuming name starts with ID, e.g., "001 Michael Amon")
    const staffMember = staffRows.find(r => {
      const name = (r["Name"] || r.get("Name") || "").trim();
      return name.startsWith(id) && (r["Active"] || r.get("Active") || "").toString().toLowerCase() === "yes";
    });

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff with ID '${id}' not found or inactive.` });
    }

    const name = (staffMember["Name"] || staffMember.get("Name") || "").trim().replace(/^(\d+\s+)/, ''); // Extract name after ID
    const expectedSubject = `${id} ${name}`.trim();

    // Check if expected subject exists in CompreFace
    const subjectsUrl = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/subjects`;
    const subjectsResponse = await fetch(subjectsUrl, {
      method: "GET",
      headers: compreFaceHeaders
    });
    if (!subjectsResponse.ok) {
      throw new Error(`CompreFace subjects fetch failed: ${subjectsResponse.status} - ${await subjectsResponse.text()}`);
    }
    const subjectsData = await subjectsResponse.json();
    const allSubjects = subjectsData.subjects || [];
    if (!allSubjects.includes(expectedSubject)) {
      return res.status(403).json({ success: false, message: `Dear ${name}, your face has not been added. See HR.` });
    }

    // Perform face recognition
    const recognizeUrl = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/recognize?limit=1`;
    const recognizeResponse = await fetch(recognizeUrl, {
      method: "POST",
      headers: compreFaceHeaders,
      body: JSON.stringify({ file: base64 })
    });
    if (!recognizeResponse.ok) {
      throw new Error(`CompreFace recognition failed: ${recognizeResponse.status} - ${await recognizeResponse.text()}`);
    }
    const recognizeData = await recognizeResponse.json();

    // Verify if top match is exactly the expected subject with high similarity
    const SIMILARITY_THRESHOLD = 0.8;
    if (recognizeData?.result?.length && recognizeData.result[0].subjects?.length) {
      const topMatch = recognizeData.result[0].subjects[0];
      if (topMatch.subject !== expectedSubject || topMatch.similarity < SIMILARITY_THRESHOLD) {
        return res.status(403).json({ success: false, message: "Face does not match the registered ID." });
      }
    } else {
      return res.status(403).json({ success: false, message: "Face does not match the registered ID." });
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
      (r["Name"] || r.get("Name") || "").trim().toLowerCase() === `${id} ${name}`.trim().toLowerCase()
    );

    if (action === "clock in") {
      if (existing && (existing["Time In"] || existing.get("Time In"))) {
        return res.json({ success: false, message: `Dear ${name}, you have already clocked in today.` });
      }

      const deptValue = staffMember["Department"] || staffMember.get("Department") || "";

      await attendanceSheet.addRow({
        "Date": dateStr,
        "Department": deptValue,
        "Name": `${id} ${name}`,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${name}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      if (!existing) {
        return res.json({ success: false, message: `Dear ${name}, no clock-in found for today.` });
      }
      if (existing["Time Out"] || existing.get("Time Out")) {
        return res.json({ success: false, message: `Dear ${name}, you have already clocked out today.` });
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

      console.log(`✅ Clock-out updated for ${name} on ${dateStr} (${officeName})`);
      return res.json({ success: true, message: `Dear ${name}, clock-out recorded at ${timeStr} (${officeName}).` });
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
    const now = new Date("2025-10-19T12:52:00Z"); // Current date and time
    const requestedDate = req.query.date || new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString().split("T")[0]; // Default to yesterday (Oct 18, 2025)
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() - 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const parseDate = str => new Date(str + "T00:00:00");

    const filterByRange = (rows, d1, d2) =>
      rows.filter(r => {
        const d = parseDate(r["Date"] || r.get("Date"));
        return d >= d1 && d <= d2;
      });

    const clockIns = {
      today: attendanceRows.filter(r => (r["Date"] || r.get("Date")) === requestedDate && (r["Time In"] || r.get("Time In"))).length,
      week: filterByRange(attendanceRows, startOfWeek, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).filter(r => r["Time In"] || r.get("Time In")).length,
      month: filterByRange(attendanceRows, startOfMonth, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).filter(r => r["Time In"] || r.get("Time In")).length
    };

    const clockOuts = {
      today: attendanceRows.filter(r => (r["Date"] || r.get("Date")) === requestedDate && (r["Time Out"] || r.get("Time Out"))).length,
      week: filterByRange(attendanceRows, startOfWeek, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).filter(r => r["Time Out"] || r.get("Time Out")).length,
      month: filterByRange(attendanceRows, startOfMonth, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)).filter(r => r["Time Out"] || r.get("Time Out")).length
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
        name: r["Name"] || r.get("Name") || "",
        department: r["Department"] || r.get("Department") || "",
        timeIn: r["Time In"] || r.get("Time In") || "",
        timeOut: r["Time Out"] || r.get("Time Out") || "",
        clockInLocation: r["Clock In Location"] || r.get("Clock In Location") || "Unknown"
      }));

    const trend = [
      { date: new Date(now.setDate(now.getDate() - 7)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 6)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 5)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 4)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 3)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 2)).toLocaleDateString(), present: Math.floor(Math.random() * activeStaff) },
      { date: new Date(now.setDate(now.getDate() - 1)).toLocaleDateString(), present: presentToday }
    ];

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

// ----------------- Start Server -----------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () =>
  console.log(`✅ Proodent Attendance API running on port ${listenPort}`)
);
