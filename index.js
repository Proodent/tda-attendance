// index.js — Proodent Attendance System Server (Robust fix for User ID, clock-out and duplicate-check issues)
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

// ----------------- Google Sheets Setup -----------------
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
const processedKey = (GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// helper: (re)authorize and load doc info
async function authAndLoadDoc() {
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: processedKey
  });
  await doc.loadInfo();
}

// helper: find sheet header name (case-insensitive) that matches friendly name
function findHeader(actualHeaders = [], desired) {
  if (!actualHeaders || !desired) return null;
  const desiredNorm = desired.toString().trim().toLowerCase();
  for (const h of actualHeaders) {
    if (h && h.toString().trim().toLowerCase() === desiredNorm) return h;
  }
  // fallback: try partial contains (helpful if headers like "User Id (system)")
  for (const h of actualHeaders) {
    if (h && h.toString().trim().toLowerCase().includes(desiredNorm)) return h;
  }
  return null;
}

// helper: get value from a row with flexible header matching
function getRowValue(row, sheetHeaderValues, friendlyName) {
  const header = findHeader(sheetHeaderValues, friendlyName);
  if (!header) return "";
  // row[header] exists on google-spreadsheet Row objects
  return (row[header] !== undefined && row[header] !== null) ? row[header].toString() : "";
}

// helper: set multiple fields on a Row and save
async function setRowFieldsAndSave(row, sheetHeaderValues, updates) {
  // updates: { friendlyFieldName: value, ... }
  for (const [friendly, val] of Object.entries(updates)) {
    const header = findHeader(sheetHeaderValues, friendly);
    if (header) {
      row[header] = val;
    } else {
      // If header missing, set as new property; google-spreadsheet may ignore unknown keys in .save(),
      // but adding here helps if header exists with slightly different name next deploy.
      row[friendly] = val;
    }
  }
  await row.save();
}

// ----------------- API: Health -----------------
app.get("/api/health", async (req, res) => {
  try {
    await authAndLoadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- API: Locations -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await authAndLoadDoc();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];
    if (!locSheet) return res.status(500).json({ success: false, error: "Locations Sheet not found" });
    const rows = await locSheet.getRows();

    const headerValues = locSheet.headerValues || [];
    const locations = rows.map(r => {
      const name = getRowValue(r, headerValues, "Location Name") || "";
      const lat = parseFloat(getRowValue(r, headerValues, "Latitude") || getRowValue(r, headerValues, "Lat") || 0);
      const lon = parseFloat(getRowValue(r, headerValues, "Longitude") || getRowValue(r, headerValues, "Long") || 0);
      const radiusMeters = parseFloat(getRowValue(r, headerValues, "Radius (Meters)") || getRowValue(r, headerValues, "Radius") || 150);
      return {
        name: name.toString(),
        lat: Number.isFinite(lat) ? lat : 0,
        long: Number.isFinite(lon) ? lon : 0,
        radiusMeters: Number.isFinite(radiusMeters) ? radiusMeters : 150
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
    const base = (COMPREFACE_URL || "").replace(/\/$/, "");
    if (!base || !COMPREFACE_API_KEY) return res.status(500).json({ success: false, error: "CompreFace config missing" });

    const url = `${base}/api/v1/recognition/recognize?limit=5`;
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

    // reauth + load fresh
    await authAndLoadDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    // load rows
    const [staffRows, attendanceRows, locRows] = await Promise.all([
      staffSheet.getRows(),
      attendanceSheet.getRows(),
      locationsSheet.getRows()
    ]);

    // header lists
    const staffHeaders = staffSheet.headerValues || [];
    const attHeaders = attendanceSheet.headerValues || [];
    const locHeaders = locationsSheet.headerValues || [];

    // find staff member (case-insensitive by Name)
    const staffMember = staffRows.find(r => {
      const nameVal = (getRowValue(r, staffHeaders, "Name") || "").toString().trim().toLowerCase();
      return nameVal === subjectName.toString().trim().toLowerCase() &&
        ( (getRowValue(r, staffHeaders, "Active") || "").toString().trim().toLowerCase() === "yes" );
    });

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });
    }

    // get user id and department from staff row using header matching
    const userId = getRowValue(staffMember, staffHeaders, "User ID") || getRowValue(staffMember, staffHeaders, "UserId") || getRowValue(staffMember, staffHeaders, "ID") || "";
    const department = getRowValue(staffMember, staffHeaders, "Department") || "";

    // require userId (prevent blank user id causing collisions)
    if (!userId || userId.toString().trim() === "") {
      return res.status(400).json({ success: false, message: `Staff '${subjectName}' does not have a User ID in Staff Sheet. Please set a User ID.` });
    }

    // prepare office locations
    const officeLocations = locRows.map(r => ({
      name: getRowValue(r, locHeaders, "Location Name") || "",
      lat: parseFloat(getRowValue(r, locHeaders, "Latitude") || getRowValue(r, locHeaders, "Lat") || 0),
      long: parseFloat(getRowValue(r, locHeaders, "Longitude") || getRowValue(r, locHeaders, "Long") || 0),
      radiusMeters: parseFloat(getRowValue(r, locHeaders, "Radius (Meters)") || getRowValue(r, locHeaders, "Radius") || 150)
    }));

    // distance helpers
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

    // detect current office
    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (Number(o.radiusMeters) / 1000)) {
        officeName = (o.name || "").toString();
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any approved location." });
    }

    // check allowed locations for staff
    const allowedRaw = getRowValue(staffMember, staffHeaders, "Allowed Locations") || "";
    const allowed = allowedRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    // prepare date/time
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeStr = dt.toTimeString().split(" ")[0];

    // --- find existing attendance row for this user & date ---
    // be careful: use attendance sheet headers to read values
    const findExisting = () => {
      return attendanceRows.find(r => {
        const rDate = getRowValue(r, attHeaders, "Date") || getRowValue(r, attHeaders, "date") || "";
        const rUser = getRowValue(r, attHeaders, "User ID") || getRowValue(r, attHeaders, "UserId") || getRowValue(r, attHeaders, "ID") || "";
        // compare trimmed strings
        return rDate.toString().trim() === dateStr && rUser.toString().trim() === userId.toString().trim();
      });
    };

    if (action === "clock in") {
      const existing = findExisting();
      if (existing && (getRowValue(existing, attHeaders, "Time In") || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      // build add object: map friendly keys to actual header names (if header exists)
      const addObj = {};
      // try to map to actual header names present in attendance sheet; fallback to friendly keys
      const mapAndSet = (friendly, value) => {
        const header = findHeader(attHeaders, friendly);
        addObj[ header || friendly ] = value;
      };
      mapAndSet("Date", dateStr);
      mapAndSet("User ID", userId);
      mapAndSet("Name", subjectName);
      mapAndSet("Department", department);
      mapAndSet("Time In", timeStr);
      mapAndSet("Clock In Location", officeName);
      mapAndSet("Time Out", "");
      mapAndSet("Clock Out Location", "");

      await attendanceSheet.addRow(addObj);
      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      const existing = findExisting();
      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }

      if ((getRowValue(existing, attHeaders, "Time Out") || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      // update using header mapping helper
      await setRowFieldsAndSave(existing, attHeaders, {
        "Time Out": timeStr,
        "Clock Out Location": officeName
      });

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
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

// ----------------- Start Server -----------------
const port = Number(PORT) || 3000;
app.listen(port, () => console.log(`✅ Proodent Attendance API running on port ${port}`));
