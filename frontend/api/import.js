import formidable from "formidable";
import * as XLSX from "xlsx";

const TARGET_LICENSE_PLATES = ["A33233/40337", "A21457/37737"];
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