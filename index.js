// index.js — Proodent Attendance System Server (fixed & robust)
import express from "express";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
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

// Utility: safe get for different header variants and trimming
function safeCellValue(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (typeof v !== "undefined" && v !== null && (v + "").trim() !== "") return (v + "").trim();
    // google-spreadsheet Row objects sometimes expose getter functions (row.get)
    if (typeof row.get === "function") {
      try {
        const g = row.get(k);
        if (typeof g !== "undefined" && g !== null && (g + "").trim() !== "") return (g + "").trim();
      } catch (e) {
        // ignore
      }
    }
  }
  return "";
}

// ----------------- Google Sheets Setup -----------------
// We'll create a doc instance and authorise on each request (robust if token/session expires)
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

async function authDoc() {
  // google private key in env often contains literal \n sequences; convert them
  const processedKey = (GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: processedKey
  });
  await doc.loadInfo();
}

// ----------------- API: Health -----------------
app.get("/api/health", async (req, res) => {
  try {
    await authDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    console.error("Health error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- API: Locations -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await authDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    if (!locSheet) return res.status(500).json({ success: false, error: "Locations Sheet not found" });
    const rows = await locSheet.getRows();

    const locations = rows.map(r => {
      // support different header names
      const name = safeCellValue(r, "Location Name", "Office Name", "Name");
      const lat = parseFloat(safeCellValue(r, "Latitude", "Lat")) || 0;
      const lon = parseFloat(safeCellValue(r, "Longitude", "Long", "Lng")) || 0;
      const radiusMeters = parseFloat(safeCellValue(r, "Radius (Meters)", "Radius")) || 150;
      return {
        name,
        lat,
        long: lon,
        radiusMeters
      };
    });

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- Proxy CompreFace -----------------
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const payload = req.body || {};
    if (!COMPREFACE_URL || !COMPREFACE_API_KEY) {
      return res.status(500).json({ success: false, error: "CompreFace config missing" });
    }
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

// ----------------- Attendance logging -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;
    if (!action || !subjectName || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid input." });
    }

    // re-auth and load sheets fresh every request
    await authDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    // load relevant rows
    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    // find staff member by name (case-insensitive)
    const staffMember = staffRows.find(r =>
      safeCellValue(r, "Name", "Full Name").toLowerCase() === (subjectName + "").toString().trim().toLowerCase()
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found.` });
    }

    const activeFlag = safeCellValue(staffMember, "Active", "IsActive") || "";
    if (activeFlag.trim().toLowerCase() !== "yes") {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not active.` });
    }

    // get required staff details
    const userId = safeCellValue(staffMember, "User ID", "UserID", "Emp ID", "Employee ID");
    const department = safeCellValue(staffMember, "Department");

    // **Important**: require User ID to avoid blank-user collisions
    if (!userId) {
      return res.status(400).json({ success: false, message: `Staff '${subjectName}' does not have a User ID in Staff Sheet.` });
    }

    // build office locations
    const officeLocations = locRows.map(r => ({
      name: safeCellValue(r, "Location Name", "Office Name"),
      lat: Number(safeCellValue(r, "Latitude", "Lat")) || 0,
      long: Number(safeCellValue(r, "Longitude", "Long", "Lng")) || 0,
      radiusMeters: Number(safeCellValue(r, "Radius (Meters)", "Radius")) || 150
    }));

    // distance functions (Haversine)
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

    // determine which office (if any)
    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (Number(o.radiusMeters) / 1000)) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any approved location." });
    }

    const allowedLocationsRaw = safeCellValue(staffMember, "Allowed Locations", "Allowed");
    const allowed = allowedLocationsRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    // prepare date/time
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    // find today's attendance row for this user (note: compare trimmed strings)
    const findAttendanceRow = () => attendanceRows.find(r => {
      const rowDate = (r["Date"] || r.get?.("Date") || "").toString().trim();
      // accept different headers for user id
      const rowUser = ((r["User ID"] || r["UserID"] || r.get?.("User ID") || r.get?.("UserID") || "") + "").toString().trim();
      return rowDate === dateStr && rowUser === userId.trim();
    });

    if (action === "clock in") {
      const existing = findAttendanceRow();
      if (existing && ((existing["Time In"] || existing.get?.("Time In") || "") + "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      // add new row — ensure header names match exactly what your sheet has
      await attendanceSheet.addRow({
        "Date": dateStr,
        "User ID": userId,
        "Department": department,
        "Name": subjectName,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      const existing = findAttendanceRow();
      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }

      const timeOutVal = ((existing["Time Out"] || existing.get?.("Time Out") || "") + "").toString().trim();
      if (timeOutVal) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = officeName;
      await existing.save(); // <-- important: persist back to sheet

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });
  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ----------------- Static Frontend -----------------
app.use(express.static(__dirname));

// Serve main user interface
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serve developer dashboard (optional)
app.get("/dev", (req, res) => {
  res.sendFile(path.join(__dirname, "developer.html"));
});

// ----------------- Start Server -----------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => console.log(`✅ Proodent Attendance API running on port ${listenPort}`));
