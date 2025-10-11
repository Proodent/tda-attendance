// index.js — Proodent Attendance System Server (improved & robust)
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

if (!SPREADSHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("❌ Missing Google Sheets configuration in .env file!");
}

// Prepare Google doc object (we will authorize before use)
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

// helper to (re-)authorize and load doc info
async function authAndLoadDoc() {
  try {
    const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: processedKey
    });
    await doc.loadInfo();
  } catch (err) {
    // rethrow so callers handle
    throw err;
  }
}

// ------------------ HEALTH ------------------
app.get("/api/health", async (req, res) => {
  try {
    await authAndLoadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------ LOCATIONS ------------------
app.get("/api/locations", async (req, res) => {
  try {
    await authAndLoadDoc();
    const sheet = doc.sheetsByTitle["Locations Sheet"];
    if (!sheet) return res.status(500).json({ success: false, error: "Locations Sheet not found" });

    const rows = await sheet.getRows();
    const locations = rows.map(r => {
      const rawRadius = r["Radius (Meters)"] ?? r["Radius"] ?? r.get?.("Radius (Meters)") ?? r.get?.("Radius") ?? "";
      const radiusMeters = Number(rawRadius) || 150;
      return {
        name: (r["Location Name"] || r.get?.("Location Name") || "").toString().trim(),
        lat: Number(r["Latitude"] ?? r.get?.("Latitude") ?? 0),
        long: Number(r["Longitude"] ?? r.get?.("Longitude") ?? 0),
        radiusMeters
      };
    });

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------ COMPRE-FACE PROXY ------------------
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const payload = req.body || {};
    const baseUrl = (COMPREFACE_URL || "").replace(/\/$/, "");
    if (!baseUrl || !COMPREFACE_API_KEY) {
      return res.status(500).json({ success: false, error: "CompreFace config missing" });
    }

    const url = `${baseUrl}/api/v1/recognition/recognize?limit=5`;

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

// ------------------ ATTENDANCE ------------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;

    if (!action || !subjectName || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid request." });
    }

    // (re)authorize and load sheets fresh for each request
    await authAndLoadDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    // load the necessary rows (staff & locations). Attendance rows will be reloaded later when needed
    const staffRows = await staffSheet.getRows();
    const locRows = await locationSheet.getRows();

    // find staff by name (case-insensitive trim)
    const staff = staffRows.find(r => (r["Name"] || "").toString().trim().toLowerCase() === subjectName.toString().trim().toLowerCase());
    if (!staff) {
      return res.status(404).json({ success: false, message: `Staff '${subjectName}' not found.` });
    }

    if ((staff["Active"] || "").toString().trim().toLowerCase() !== "yes") {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' is inactive.` });
    }

    const userId = (staff["User ID"] || staff.get?.("User ID") || "").toString().trim();
    const department = (staff["Department"] || staff.get?.("Department") || "").toString().trim();

    if (!userId) {
      return res.status(400).json({ success: false, message: `No User ID found for ${subjectName}. Please update Staff Sheet.` });
    }

    // build office list
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get?.("Location Name") || "").toString().trim(),
      lat: Number(r["Latitude"] ?? r.get?.("Latitude") ?? 0),
      long: Number(r["Longitude"] ?? r.get?.("Longitude") ?? 0),
      radiusMeters: Number(r["Radius (Meters)"] ?? r["Radius"] ?? r.get?.("Radius") ?? 150)
    }));

    // distance calculation (km)
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

    // detect which office (if any)
    let currentOffice = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (Number(o.radiusMeters) / 1000)) {
        currentOffice = o.name;
        break;
      }
    }

    if (!currentOffice) {
      return res.status(403).json({ success: false, message: "You are outside all approved locations." });
    }

    // check allowed locations (Staff -> Allowed Locations)
    const allowedRaw = (staff["Allowed Locations"] || staff.get?.("Allowed Locations") || "").toString();
    const allowedList = allowedRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowedList.includes(currentOffice)) {
      return res.status(403).json({ success: false, message: `You are not allowed to ${action} at ${currentOffice}.` });
    }

    // date/time
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    // reload attendance rows now (fresh)
    const attendanceRows = await attendanceSheet.getRows();

    if (action === "clock in") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || "").toString().trim() === dateStr &&
        (r["User ID"] || "").toString().trim() === userId
      );

      if (existing && (existing["Time In"] || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      // write row using expected header names exactly
      await attendanceSheet.addRow({
        "User ID": userId,
        "Name": subjectName,
        "Department": department,
        "Date": dateStr,
        "Time In": timeStr,
        "Clock In Location": currentOffice,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${currentOffice}).` });
    }

    if (action === "clock out") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || "").toString().trim() === dateStr &&
        (r["User ID"] || "").toString().trim() === userId
      );

      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }

      if ((existing["Time Out"] || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = currentOffice;
      await existing.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${currentOffice}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });
  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ------------------ STATIC FRONTEND ------------------
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

// ------------------ START ------------------
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => console.log(`✅ Proodent Attendance API running on port ${listenPort}`));
