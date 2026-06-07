import formidable from "formidable";
import * as XLSX from "xlsx";

const TARGET_LICENSE_PLATES = ["A06725/32431", "A09321/32699"];
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
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

// Wrap formidable's callback-based parse in a Promise so we can properly await it.
// Without this, the async work inside the callback (fetch to Supabase, res.redirect)
// races against the serverless function terminating — causing silent failures on Vercel.
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({});
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let files;
  try {
    ({ files } = await parseForm(req));
  } catch (err) {
    console.error("Form parse error:", err);
    return res.redirect(302, "/?from=shortcut&status=error");
  }

  const file = files.file?.[0];
  if (!file) {
    return res.redirect(302, "/?from=shortcut&status=error");
  }

  let workbook;
  try {
    workbook = XLSX.readFile(file.filepath);
  } catch (err) {
    console.error("XLSX read error:", err);
    return res.redirect(302, "/?from=shortcut&status=error");
  }

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
    if (TARGET_LICENSE_PLATES.some((t) => normalizePlate(t) === normalizePlate(plate))) {
      targetRows.push({
        arrival_date,
        batch_time,
        license_plate: plate,
        arrival_code: code,
        product_type: String(row[3] || "").trim() || null,
        company: String(row[4] || "").trim() || null,
      });
    }
  }

  if (!targetRows.length) {
    return res.redirect(302, "/?from=shortcut&status=not_found");
  }

  // Save to Supabase — properly awaited now
  let savedData;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(targetRows),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("Supabase error:", response.status, responseText);
      // Even if Supabase rejected (e.g. duplicate), the plates WERE in the file.
      // Redirect with what we know from the parsed file so the app can still show something.
      const rows = targetRows.map((r, i) => ({
        id: `local-${i}`,
        license_plate: r.license_plate,
        arrival_code: r.arrival_code,
        arrival_date: r.arrival_date,
        batch_time: r.batch_time,
      }));
      const payload = Buffer.from(JSON.stringify(rows)).toString("base64url");
      return res.redirect(302, `/?from=shortcut&status=db_error&rows=${payload}`);
    }

    savedData = JSON.parse(responseText);
  } catch (fetchErr) {
    console.error("Fetch error:", fetchErr);
    return res.redirect(302, "/?from=shortcut&status=error");
  }

  // Encode as base64 JSON — avoids all comma/slash/encoding edge cases with plates
  const rows = savedData.map((r) => ({
    id: String(r.id),
    license_plate: r.license_plate || "",
    arrival_code: r.arrival_code || "",
    arrival_date: r.arrival_date || "",
    batch_time: r.batch_time || "",
  }));

  const payload = Buffer.from(JSON.stringify(rows)).toString("base64url");
  return res.redirect(302, `/?from=shortcut&status=saved&rows=${payload}`);
}