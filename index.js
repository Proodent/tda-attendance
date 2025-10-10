// ==============================
//  PROODENT ATTENDANCE BACKEND
// ==============================

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { GoogleSpreadsheet } from "google-spreadsheet";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ==============================
//  ENVIRONMENT CONFIG
// ==============================
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

// ==============================
//  GOOGLE SHEETS CONNECTION
// ==============================
const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

async function authDoc() {
  if (!doc.client_email) {
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY,
    });
  }
}

// ==============================
//  ROOT TEST ENDPOINT
// ==============================
app.get("/", (req, res) => {
  res.send("✅ Proodent Attendance API is running");
});

// ==============================
//  HEALTH CHECK ENDPOINT
// ==============================
app.get("/api/health", async (req, res) => {
  try {
    await authDoc();
    await doc.loadInfo();
    res.json({
      success: true,
      status: "ok",
      spreadsheetTitle: doc.title,
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(500).json({
      success: false,
      status: "error",
      error: err.message,
    });
  }
});

// ==============================
//  LOCATIONS ENDPOINT
// ==============================
app.get("/api/locations", async (req, res) => {
  try {
    await authDoc();
    await doc.loadInfo();
    const locSheet = doc.sheetsByTitle["Locations Sheet"];

    if (!locSheet) {
      return res.status(404).json({
        success: false,
        message: "Locations Sheet not found",
      });
    }

    const rows = await locSheet.getRows();

    const locations = rows.map((r) => ({
      name: r["Location Name"] || "",
      latitude: parseFloat(r["Latitude"] || 0),
      longitude: parseFloat(r["Longitude"] || 0),
      radius: parseFloat(r["Radius"] || 150),
    }));

    res.json({ success: true, locations });
  } catch (err) {
    console.error("Error loading locations:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================
//  STAFF ENDPOINT
// ==============================
app.get("/api/staff", async (req, res) => {
  try {
    await authDoc();
    await doc.loadInfo();
    const staffSheet = doc.sheetsByTitle["Staff Sheet"];

    if (!staffSheet) {
      return res.status(404).json({
        success: false,
        message: "Staff Sheet not found",
      });
    }

    const rows = await staffSheet.getRows();

    const staff = rows.map((r) => ({
      name: r["Name"] || "",
      userId: r["User ID"] || "",
      department: r["Department"] || "",
      active: (r["Active"] || "").toString().toLowerCase() === "true",
      allowedLocations:
        (r["Allowed Locations"] || "")
          .split(",")
          .map((loc) => loc.trim())
          .filter((loc) => loc.length > 0) || [],
    }));

    res.json({ success: true, staff });
  } catch (err) {
    console.error("Error loading staff:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================
//  ATTENDANCE ENDPOINT
// ==============================
app.get("/api/attendance", async (req, res) => {
  try {
    await authDoc();
    await doc.loadInfo();
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];

    if (!attendanceSheet) {
      return res.status(404).json({
        success: false,
        message: "Attendance Sheet not found",
      });
    }

    const rows = await attendanceSheet.getRows();

    const attendance = rows.map((r) => ({
      name: r["Name"] || "",
      userId: r["User ID"] || "",
      department: r["Department"] || "",
      date: r["Date"] || "",
      timeIn: r["Time In"] || "",
      clockInLocation: r["Clock In Location"] || "",
      timeOut: r["Time Out"] || "",
      clockOutLocation: r["Clock Out Location"] || "",
    }));

    res.json({ success: true, attendance });
  } catch (err) {
    console.error("Error loading attendance:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================
//  ADD NEW ATTENDANCE RECORD
// ==============================
app.post("/api/attendance", async (req, res) => {
  try {
    const {
      name,
      userId,
      department,
      date,
      timeIn,
      clockInLocation,
      timeOut,
      clockOutLocation,
    } = req.body;

    await authDoc();
    await doc.loadInfo();
    const attendanceSheet = doc.sheetsByTitle["Attendance Sheet"];

    if (!attendanceSheet) {
      return res.status(404).json({
        success: false,
        message: "Attendance Sheet not found",
      });
    }

    await attendanceSheet.addRow({
      Name: name,
      "User ID": userId,
      Department: department,
      Date: date,
      "Time In": timeIn,
      "Clock In Location": clockInLocation,
      "Time Out": timeOut,
      "Clock Out Location": clockOutLocation,
    });

    res.json({ success: true, message: "Attendance added successfully" });
  } catch (err) {
    console.error("Error adding attendance:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================
//  SERVER LISTEN
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
