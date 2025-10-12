// ====================== IMPORTS ======================
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";

dotenv.config();

// ====================== APP SETUP ======================
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// ====================== GOOGLE SHEETS SETUP ======================
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

// Load document info
async function loadDoc() {
  if (!doc._rawProperties) {
    await doc.loadInfo();
    console.log("📘 Spreadsheet loaded:", doc.title);
  }
}

// ====================== HEALTH CHECK ======================
app.get("/api/health", async (req, res) => {
  try {
    await loadDoc();
    res.status(200).json({ success: true, message: "Backend connected successfully." });
  } catch (err) {
    console.error("Health check error:", err.message);
    res.status(500).json({ success: false, message: "Backend unreachable", error: err.message });
  }
});

// ====================== LOCATIONS ENDPOINT ======================
app.get("/api/locations", async (req, res) => {
  try {
    await loadDoc();
    const sheet = doc.sheetsByTitle["Locations Sheet"];
    if (!sheet) return res.status(404).json({ success: false, message: "Locations Sheet not found." });

    const rows = await sheet.getRows();
    const locations = rows.map(r => ({
      name: r["Location Name"],
      latitude: parseFloat(r["Latitude"]),
      longitude: parseFloat(r["Longitude"]),
      radiusMeters: parseFloat(r["Radius (Meters)"]) || 150,
    }));

    res.status(200).json({ success: true, data: locations });
  } catch (err) {
    console.error("Error loading locations:", err.message);
    res.status(500).json({ success: false, message: "Error loading locations", error: err.message });
  }
});

// ====================== ATTENDANCE ENDPOINT ======================
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

    // Utility function for safe value reading
    const getValue = (row, names) => {
      for (const n of names) {
        if (row[n] !== undefined && row[n] !== null && row[n] !== "") return row[n];
        if (row.get && row.get(n) !== undefined && row.get(n) !== null && row.get(n) !== "") return row.get(n);
      }
      return "";
    };

    // Find staff member
    const staffMember = staffRows.find(r =>
      (getValue(r, ["Name"]).toString().trim().toLowerCase()) === subjectName.toString().trim().toLowerCase() &&
      getValue(r, ["Active"]).toString().trim().toLowerCase() === "yes"
    );

    if (!staffMember) {
      return res.status(403).json({ success: false, message: `Staff '${subjectName}' not found or inactive.` });
    }

    const userId = String(getValue(staffMember, ["User ID", "User Id", "UserID", "ID"])).trim();
    const department = String(getValue(staffMember, ["Department", "Dept"])).trim();

    if (!userId) {
      return res.status(400).json({ success: false, message: `User ID missing for staff '${subjectName}'.` });
    }

    // Get allowed office locations
    const officeLocations = locRows.map(r => ({
      name: getValue(r, ["Location Name"]).toString(),
      lat: parseFloat(getValue(r, ["Latitude"])) || 0,
      long: parseFloat(getValue(r, ["Longitude"])) || 0,
      radiusMeters: parseFloat(getValue(r, ["Radius", "Radius (Meters)"])) || 150,
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

    // Check if inside approved location
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

    // Check allowed locations for this staff
    const allowedLocationsRaw = String(getValue(staffMember, ["Allowed Locations"]));
    const allowed = allowedLocationsRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(officeName)) {
      return res.status(403).json({ success: false, message: `You are not permitted to ${action} at ${officeName}.` });
    }

    const dt = new Date(timestamp);
    const dateStr = dt.toISOString().split("T")[0];
    const timeStr = dt.toTimeString().split(" ")[0];

    // Find today's record for this user
    const existing = attendanceRows.find(r => {
      const rowDate = String(getValue(r, ["Date"])).trim();
      const rowUID = String(getValue(r, ["User ID", "User Id", "UserID", "ID"])).trim();
      return rowDate === dateStr && rowUID && rowUID === userId;
    });

    // Dynamic headers fix
    const headers = attendanceSheet.headerValues.map(h => h.trim());
    const timeOutHeader = headers.find(h => /^time\s*out$/i.test(h)) || "Time Out";
    const locOutHeader = headers.find(h => /^clock\s*out\s*location$/i.test(h)) || "Clock Out Location";
    const timeInHeader = headers.find(h => /^time\s*in$/i.test(h)) || "Time In";

    // CLOCK IN
    if (action.toLowerCase() === "clock in") {
      if (existing && getValue(existing, [timeInHeader])) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked in today.` });
      }

      await attendanceSheet.addRow({
        "User ID": userId,
        "Name": subjectName,
        "Department": department,
        "Date": dateStr,
        "Time In": timeStr,
        "Clock In Location": officeName,
        "Time Out": "",
        "Clock Out Location": "",
      });

      console.log(`✅ ${subjectName} (${userId}) clocked in at ${officeName}`);
      return res.json({ success: true, message: `Dear ${subjectName}, clock-in recorded at ${timeStr} (${officeName}).` });
    }

    // CLOCK OUT
    if (action.toLowerCase() === "clock out") {
      if (!existing) {
        return res.json({ success: false, message: `Dear ${subjectName}, no clock-in found for today.` });
      }
      if (getValue(existing, [timeOutHeader])) {
        return res.json({ success: false, message: `Dear ${subjectName}, you have already clocked out today.` });
      }

      existing[timeOutHeader] = timeStr;
      existing[locOutHeader] = officeName;
      await existing.save(true);

      console.log(`✅ ${subjectName} (${userId}) clocked out at ${officeName}`);
      return res.json({ success: true, message: `Dear ${subjectName}, clock-out recorded at ${timeStr} (${officeName}).` });
    }

    res.status(400).json({ success: false, message: "Unknown action." });

  } catch (err) {
    console.error("POST /api/attendance/web error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ====================== START SERVER ======================
app.listen(PORT, async () => {
  try {
    await loadDoc();
    console.log(`🚀 Server running on port ${PORT}`);
  } catch (err) {
    console.error("❌ Failed to load Google Sheet:", err.message);
  }
});
