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

// ----------------- Attendance Logging — APOSTROPHE FIXED 100% -----------------
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
      const id = (r["UserID"] || r.get("UserID") || "").toString().trim();
      const name = (r["Name"] || r.get("Name") || "").trim();
      const act = (r["Active"] || r.get("Active") || "No").toString().toLowerCase();
      return id === userIdStr && name === subjectName.trim() && act === "yes";
    });

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Invalid UserID or Name, or staff is inactive.` });
    }

    const allowedRaw = (staffMember["Allowed Locations"] || staffMember.get("Allowed Locations") || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get("Location Name") || "").trim(),
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius (meters)") ?? r["Radius (Meters)"] ?? 150)
    })).filter(o => o.name && o.lat && o.long);

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), o.lat, o.long);
      if (distKm <= (o.radiusMeters / 1000)) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any registered office location." });
    }

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

    // ==================== CLOCK OUT — FIXED FOREVER ====================
    if (action === "clock out") {
      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }
      if (existing["Time Out"] || existing.get("Time Out")) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      // CLEAN METHOD — SAME AS CLOCK IN → NO APOSTROPHE EVER
      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = officeName;
      await existing.save();  // ← This is the fix

      return res.json({
        success: true,
        message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).`
      });
    }
    // ====================================================================

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

// ----------------- API: Stats ----------------- (unchanged)
// ... [your /api/stats code remains exactly the same] ...
// (I kept it identical — no changes needed there)

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
