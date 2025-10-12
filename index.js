// index.js — Proodent Attendance System Server (Stable Release)
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
const processedKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

async function loadDoc() {
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: processedKey,
  });
  await doc.loadInfo();
}

// ----------------- API: Health -----------------
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.json({ success: true, message: "Google Sheets connected successfully!" });
  } catch (err) {
    console.error("Health check failed:", err);
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

    const locations = rows.map(r => {
      const name = r["Location Name"] ?? r.get("Location Name") ?? "";
      const lon = parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0);
      const lat = parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0);
      const radiusMeters = parseFloat(r["Radius"] ?? r.get("Radius") ?? r["Radius (Meters)"] ?? 150);
      return {
        name: (name || "").toString(),
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

    await loadDoc();

    const staffSheet = doc.sheetsByTitle["Staff Sheet"];
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];
    const locationsSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!staffSheet || !attendanceSheet || !locationsSheet) {
      return res.status(500).json({ success: false, message: "Required sheet(s) not found." });
    }

    const staffRows = await staffSheet.getRows();
    const attendanceRows = await attendanceSheet.getRows();
    const locRows = await locationsSheet.getRows();

    const staffMember = staffRows.find(r =>
      (r["Name"] || r.get("Name") || "").toString().trim() === subjectName.toString().trim() &&
      (r["Active"] || r.get("Active") || "").toString().trim().toLowerCase() === "yes"
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });
    }

    // --- Verify location ---
    const officeLocations = locRows.map(r => ({
      name: (r["Location Name"] || r.get("Location Name") || "").toString(),
      lat: parseFloat(r["Latitude"] ?? r.get("Latitude") ?? 0),
      long: parseFloat(r["Longitude"] ?? r.get("Longitude") ?? 0),
      radiusMeters: parseFloat(r["Radius"] ?? r.get("Radius") ?? r["Radius (Meters)"] ?? 150)
    }));

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

    let officeName = null;
    for (const o of officeLocations) {
      const distKm = getDistanceKm(Number(latitude), Number(longitude), Number(o.lat), Number(o.long));
      if (distKm <= (o.radiusMeters / 1000)) {
        officeName = o.name;
        break;
      }
    }

    if (!officeName) {
      return res.status(403).json({ success: false, message: "Not inside any approved location." });
    }

    const allowedLocationsRaw = (staffMember["Allowed Locations"] || staffMember.get("Allowed Locations") || "") + "";
    const allowed = allowedLocationsRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    const userId = (staffMember["User ID"] || staffMember.get("User ID") || "").toString();
    const department = (staffMember["Department"] || staffMember.get("Department") || "").toString();

    // --- Clock In ---
    if (action === "clock in") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || r.get("Date")) === dateStr &&
        (r["User ID"] || r.get("User ID")) === userId
      );
      if (existing && (existing["Time In"] || existing.get("Time In"))) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

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

    // --- Clock Out ---
    if (action === "clock out") {
      const existing = attendanceRows.find(r =>
        (r["Date"] || r.get("Date")) === dateStr &&
        (r["User ID"] || r.get("User ID")) === userId
      );

      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }
      if (existing["Time Out"] || existing.get("Time Out")) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing["Time Out"] = timeStr;
      existing["Clock Out Location"] = officeName;
      await existing.save();

      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    res.status(400).json({ success: false, message: "Unknown action." });

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
