import formidable from "formidable";
import * as XLSX from "xlsx";

const TARGET_LICENSE_PLATES = ["A09321/32699", "A06725/32431"];
const SUPABASE_URL = "https://ceaznmvgerreomiklcwo.supabase.co";
const SUPABASE_KEY = "sb_publishable_kF30JdMpqmsM9VmXPZLYAw_i8V58YJJ";
const SUPABASE_TABLE = "truck_arrivals";

function normalizePlate(value) {
  return String(value || "").trim().toUpperCase();
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA").format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = formidable({});
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ error: "Could not parse file" });

    const file = files.file?.[0];
    if (!file) return res.status(400).json({ error: "No file received" });

    const workbook = XLSX.readFile(file.filepath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    const now = new Date();
    const arrival_date = formatDate(now);
    const batch_time = formatTime(now);

    const targetRows = [];
    for (const row of matrix) {
      const serial = String(row[0] || "").trim();
      const plate = String(row[1] || "").trim();
      const code = String(row[2] || "").trim();
      if (!/^\d+$/.test(serial) || !plate || !code) continue;
      if (TARGET_LICENSE_PLATES.some(t => normalizePlate(t) === normalizePlate(plate))) {
        targetRows.push({
          arrival_date,
          batch_time,
          license_plate: plate,
          arrival_code: code,
          product_type: String(row[3] || "").trim() || null,
          company: String(row[4] || "").trim() || null
        });
      }
    }

    if (!targetRows.length) return res.status(200).json({ message: "No target plates found", saved: 0 });

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(targetRows)
    });

    if (!response.ok) return res.status(500).json({ error: "Failed to save to Supabase" });
    return res.status(200).json({ message: "Saved", saved: targetRows.length });
  });
}








// ─────────────────────────────────────────────────────────────────────────────
// FILE: frontend/api/import.js
// PURPOSE: Vercel serverless API function that receives an Excel file,
//          parses it, finds rows matching the target license plates,
//          and saves those rows to Supabase.
//
// ENDPOINT: POST https://truck-tracker-six.vercel.app/api/import
//
// HOW IT FITS INTO THE SYSTEM:
//   1. User receives an Excel file in WhatsApp
//   2. User taps Share -> Truck Tracker Import (iOS Shortcut)
//   3. The Shortcut sends the file to this endpoint via HTTP POST
//   4. This function parses the Excel, finds the target plates,
//      and saves matching rows to the Supabase "truck_arrivals" table
//   5. The Shortcut then opens the app at:
//      https://truck-tracker-six.vercel.app/?from=shortcut
//   6. The app detects "?from=shortcut" in the URL, waits 2 seconds,
//      fetches the latest rows, highlights any row saved in the last
//      1 minute, and shows a popup confirming what was saved
//
// ─────────────────────────────────────────────────────────────────────────────
// IOS SHORTCUT SETUP (step by step):
//
//   1. Open the Shortcuts app on iPhone
//   2. Tap + to create a new shortcut
//   3. Add action: "Get Contents of URL"
//      - URL:    https://truck-tracker-six.vercel.app/api/import
//      - Method: POST
//      - Request Body: Form
//      - Add field -> File
//        Key:   file
//        Value: Shortcut Input
//   4. Add action: "Open URLs"
//      - URL: https://truck-tracker-six.vercel.app/?from=shortcut
//   5. Tap the shortcut name at the top -> Rename -> "Truck Tracker Import"
//   6. Done. To use: open a file in WhatsApp -> Share -> Truck Tracker Import
//
// ─────────────────────────────────────────────────────────────────────────────
// TARGET LICENSE PLATES:
//   - A33233/40337
//   - A21457/37737
//   To add or change plates, update the TARGET_LICENSE_PLATES array
//   in both this file and frontend/src/App.js
//
// SUPABASE TABLE: truck_arrivals
//   Columns: arrival_date, batch_time, license_plate,
//            arrival_code, product_type, company, created_at
//
// DEPENDENCIES:
//   - formidable  (parses the incoming multipart/form-data file upload)
//   - xlsx        (reads and parses the Excel file)
//
// DEPLOYMENT:
//   - Hosted on Vercel automatically alongside the React frontend
//   - Any push to the main branch on GitHub triggers a new deployment
//   - Root directory is set to "frontend" in the Vercel dashboard settings
// ─────────────────────────────────────────────────────────────────────────────