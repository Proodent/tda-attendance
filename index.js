// index.js
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import cors from "cors";
import { GoogleSpreadsheet } from "google-spreadsheet";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 3000;

// 🔹 CompreFace settings
const COMPREFACE_URL = process.env.COMPREFACE_URL || "http://server.proodentit.com:8081";
const COMPREFACE_API_KEY = process.env.COMPREFACE_API_KEY || "4f4766d9-fc3b-436a-b24e-f57851a1c865";

// 🔹 Google Sheets (for office locations)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "YOUR_SHEET_ID_HERE";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "your-service-account@project.iam.gserviceaccount.com";
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static("public"));

// ------------------ LOAD LOCATIONS ------------------
let cachedLocations = [];

async function loadLocations() {
  try {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY,
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    cachedLocations = rows
      .filter(r => r.name && r.lat && r.long)
      .map(r => ({
        name: r.name.trim(),
        lat: parseFloat(r.lat),
        long: parseFloat(r.long),
        radiusMeters: Number(r.radiusMeters || 150),
      }));

    console.log(`✅ Loaded ${cachedLocations.length} office locations from Google Sheets.`);
  } catch (err) {
    console.error("❌ Error loading Google Sheet:", err);
  }
}

// ------------------ ROUTES ------------------

// 1️⃣ Locations route
app.get("/api/locations", async (req, res) => {
  if (!cachedLocations.length) await loadLocations();
  if (!cachedLocations.length)
    return res.json({ success: false, message: "No locations found." });

  res.json({ success: true, locations: cachedLocations });
});

// 2️⃣ Face Recognition Proxy
app.post("/api/proxy/face-recognition", async (req, res) => {
  try {
    const { file } = req.body; // frontend sends { file: "<base64>" }
    if (!file)
      return res
        .status(400)
        .json({ success: false, message: "No image received from frontend." });

    const url = `${COMPREFACE_URL.replace(/\/$/, "")}/api/v1/recognition/recognize?limit=5`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": COMPREFACE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_base64: file }), // ✅ CompreFace expects "image_base64"
    });

    const data = await response.json();

    // 🧠 Log recognition results
    if (data?.result?.length && data.result[0].subjects?.length) {
      const top = data.result[0].subjects[0];
      console.log(`✅ Match found: ${top.subject} (${(top.similarity * 100).toFixed(1)}%)`);
    } else {
      console.log("⚠️ No match found.");
    }

    res.json(data);
  } catch (err) {
    console.error("❌ CompreFace proxy error:", err);
    res.status(500).json({
      success: false,
      error: "CompreFace proxy error",
      details: err.message,
    });
  }
});

// 3️⃣ Attendance endpoint
app.post("/api/attendance/web", async (req, res) => {
  try {
    const { action, subjectName, latitude, longitude, timestamp } = req.body;

    if (!subjectName || !action) {
      return res.json({
        success: false,
        message: "Missing subject name or action.",
      });
    }

    // You could save this to a database or Google Sheet.
    console.log(
      `🕒 Attendance ${action.toUpperCase()} recorded for ${subjectName} @ [${latitude}, ${longitude}] on ${timestamp}`
    );

    res.json({
      success: true,
      message: `Dear ${subjectName}, ${action} recorded successfully.`,
    });
  } catch (err) {
    console.error("❌ Attendance API error:", err);
    res.json({
      success: false,
      message: "Server error while logging attendance.",
    });
  }
});

// ------------------ SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  loadLocations(); // preload office locations
});
