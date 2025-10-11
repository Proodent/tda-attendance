// index.js — Proodent / Tolon Attendance Server
import express from "express";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import dotenv from "dotenv";
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// __dirname fix for ES modules
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
  console.error("❌ Missing Google Sheets configuration in .env");
}

// Google Sheets doc (we authorize on-demand)
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

async function authAndLoadDoc() {
  const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: processedKey,
  });
  await doc.loadInfo();
}

// ----------------- HEALTH -----------------
app.get("/api/health", async (req, res) => {
  try {
    await authAndLoadDoc();
    res.json({ success: true, message: "OK" });
  } catch (err) {
    console.error("Health error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- LOCATIONS -----------------
app.get("/api/locations", async (req, res) => {
  try {
    await authAndLoadDoc();
    const sheet = doc.sheetsByTitle["Locations Sheet"];
    if (!sheet) return res.status(500).json({ success: false, error: "Locations Sheet not found" });

    const rows = await sheet.getRows();
    const locations = rows.map(r => {
      // tolerate column header variants
      const name = (r["Location Name"] ?? r.get?.("Location Name") ?? "").toString().trim();
      const lat = Number(r["Latitude"] ?? r.get?.("Latitude") ?? r["Lat"] ?? 0);
      const long = Number(r["Longitude"] ?? r.get?.("Longitude") ?? r["Long"] ?? 0);
      const radiusMeters = Number(r["Radius (Meters)"] ?? r["Radius"] ?? r.get?.("Radius") ?? 150) || 150;
      return { name, lat, long, radiusMeters };
    });

    res.json({ success: true, locations });
  } catch (err) {
    console.error("GET /api/locations error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------- COMPRE-FACE PROXY -----------------
// This accepts JSON with whatever front-end sends (we recommend { file: "<base64>" }).
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    if (!COMPREFACE_URL || !COMPREFACE_API_KEY) {
      return res.status(500).json({ success: false, error: "CompreFace config missing" });
    }
    const base = COMPREFACE_URL.replace(/\/$/, "");
    const url = `${base}/api/v1/recognition/recognize?limit=5`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error("POST /api/proxy/face-recognition error:", err);
    return res.status(500).json({ success: false, error: "CompreFace proxy error", details: err.message });
  }
});

// ----------------- ATTENDANCE LOGGING -----------------
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;
    if (!action || !subjectName || isNaN(Number(latitude)) || isNaN(Number(longitude)) || !timestamp) {
      return res.status(400).json({ success: false, message: "Invalid input." });
    }

    await authAndLoadDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    // load rows
    const staffRows = await staffSheet.getRows();
    const attendanceRows = await attendanceSheet.getRows();
    const locRows = await locationsSheet.getRows();

    // find staff by name (case-insensitive)
    const staffMember = staffRows.find(r => (r["Name"] || "").toString().trim().toLowerCase() === subjectName.toString().trim().toLowerCase());
    if (!staffMember) return res.status(404).json({ success: false, message: `Staff '${subjectName}' not found.` });

    if ((staffMember["Active"] || "").toString().trim().toLowerCase() !== "yes")
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' inactive.` });

    const userId = (staffMember["User ID"] || staffMember.get?.("User ID") || "").toString().trim();
    const department = (staffMember["Department"] || staffMember.get?.("Department") || "").toString().trim();

    if (!userId) {
      // Must have user id
      return res.status(400).json({ success: false, message: `User ID missing for ${subjectName}. Update Staff Sheet.` });
    }

    // build locations list
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get?.("Location Name") || "").toString().trim(),
      lat: Number(r["Latitude"] ?? r.get?.("Latitude") ?? 0),
      long: Number(r["Longitude"] ?? r.get?.("Longitude") ?? 0),
      radiusMeters: Number(r["Radius (Meters)"] ?? r["Radius"] ?? r.get?.("Radius") ?? 150)
    }));

    // haversine distance (km)
    function toRad(v) { return v * Math.PI / 180; }
    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    // detect which office (if any)
    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (o.radiusMeters / 1000)) { officeName = o.name; break; }
    }
    if (!officeName) return res.status(403).json({ success: false, message: "Not inside any approved location." });

    // allowed locations check
    const allowedRaw = (staffMember["Allowed Locations"] || staffMember.get?.("Allowed Locations") || "").toString();
    const allowed = allowedRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    // prepare date/time
    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];   // YYYY-MM-DD
    const timeStr = dt.toTimeString().split(" ")[0];  // HH:MM:SS

    if (action === "clock in") {
      // ensure we match by date + user id
      const existing = attendanceRows.find(r =>
        (r["Date"] || r.get?.("Date") || "").toString().trim() === dateStr &&
        ((r["User ID"] || r.get?.("User ID") || "").toString().trim() === userId)
      );

      if (existing && (existing["Time In"] || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      await attendanceSheet.addRow({
        "Date": dateStr,
        "User ID": userId,
        "Name": subjectName,
        "Department": department,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": ""
      });

      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    if (action === "clock out") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || r.get?.("Date") || "").toString().trim() === dateStr &&
        ((r["User ID"] || r.get?.("User ID") || "").toString().trim() === userId)
      );

      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }

      if ((existing["Time Out"] || "").toString().trim()) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = officeName;
      await existing.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    return res.status(400).json({ success: false, message: "Unknown action." });
  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ----------------- STATIC -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/dev", (req, res) => res.sendFile(path.join(__dirname, "developer.html")));

// START
const port = Number(PORT) || 3000;
app.listen(port, () => console.log(`✅ Attendance API listening on ${port}`));
