import express from "express";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";
import path from "path";
import cors from "cors";

dotenv.config();
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors());

// ==================== ENV VARIABLES ====================
const {
  COMPREFACE_API_KEY,
  COMPREFACE_BASE_URL,
  GOOGLE_SERVICE_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_SHEET_ID
} = process.env;

// ==================== GOOGLE SHEETS AUTH ====================
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_EMAIL,
  key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);

// ==================== ROUTES ====================

// Health check
app.get("/", (req, res) => {
  res.send("✅ Attendance system server running.");
});

// Proxy for CompreFace
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const { image } = req.body;
    const url = `${COMPREFACE_BASE_URL}/api/v1/recognition/recognize`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ image_base64: image })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "CompreFace proxy error" });
  }
});

// ==================== ATTENDANCE ENDPOINT ====================
app.post("/api/attendance/web", async (req, res) => {
  const { action, latitude, longitude, timestamp, subjectName } = req.body;
  console.log(`📥 Attendance request: ${action} | ${subjectName} | ${latitude}, ${longitude}`);

  if (!action || !subjectName || isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ success: false, message: "Invalid input received." });
  }

  try {
    await doc.loadInfo();
    const staffSheet = doc.sheetsByTitle["Staff"];
    const attendanceSheet = doc.sheetsByTitle["Attendance"];

    if (!staffSheet || !attendanceSheet) {
      return res.status(404).json({ success: false, message: "Required sheet(s) not found." });
    }

    const staffRows = await staffSheet.getRows();
    const staffMember = staffRows.find(
      (row) => row.get("Name")?.trim() === subjectName.trim() && row.get("Active") === "Yes"
    );

    if (!staffMember) {
      return res.status(404).json({
        success: false,
        message: `No active staff found for name: ${subjectName}`
      });
    }

    // Record attendance
    const now = new Date(timestamp);
    const formattedDate = now.toLocaleDateString();
    const formattedTime = now.toLocaleTimeString();

    await attendanceSheet.addRow({
      Date: formattedDate,
      Name: subjectName,
      Action: action,
      Latitude: latitude,
      Longitude: longitude,
      Timestamp: formattedTime
    });

    console.log(`✅ Attendance logged for ${subjectName} (${action})`);
    res.json({ success: true, message: "Attendance recorded successfully." });
  } catch (err) {
    console.error("❌ Attendance logging error:", err);
    res.status(500).json({
      success: false,
      message: "Server error while logging attendance.",
      error: err.message
    });
  }
});

// ==================== STATIC FILES ====================
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
