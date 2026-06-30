import formidable from "formidable";
import * as XLSX from "xlsx";

const TARGET_LICENSE_PLATES = ["A06725/32431", "A09321/32669"];
const SUPABASE_URL = "https://ceaznmvgerreomiklcwo.supabase.co";
const SUPABASE_KEY = "sb_publishable_kF30JdMpqmsM9VmXPZLYAw_i8V58YJJ";
const SUPABASE_TABLE = "truck_arrivals";

function normalizePlate(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function compactPlateText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function findMatchingTargetPlate(value) {
  const compactCell = compactPlateText(value);
  if (!compactCell) return null;
  return (
    TARGET_LICENSE_PLATES.find((plate) => {
      const compactPlate = compactPlateText(plate);
      return compactPlate && (compactCell === compactPlate || compactCell.includes(compactPlate));
    }) || null
  );
}

function pickFallbackCell(cells, usedIndexes) {
  const index = cells.findIndex((cell, i) => !usedIndexes.has(i) && String(cell ?? "").trim() !== "");
  return index >= 0 ? index : undefined;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA").format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

const TARGET_LICENSE_PLATE_SET = new Set(TARGET_LICENSE_PLATES.map(normalizePlate));

function cleanCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isDateLike(value) {
  const text = cleanCell(value);
  return /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(text) || /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(text);
}

function toIsoDate(value) {
  const text = cleanCell(value);
  const match = text.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
  if (!match) return "";

  let [, first, second, third] = match;
  let year;
  let month;
  let day;

  if (first.length === 4) {
    year = first;
    month = second;
    day = third;
  } else {
    day = first;
    month = second;
    year = third.length === 2 ? `20${third}` : third;
  }

  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function isTimeLike(value) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanCell(value));
}

function isPlateLike(value) {
  const plate = normalizePlate(value);
  return TARGET_LICENSE_PLATE_SET.has(plate) || findMatchingTargetPlate(value) !== null || /^[A-Z]?\d{4,6}\/\d{4,6}$/.test(plate);
}

function isArrivalCodeLike(value) {
  const text = cleanCell(value);
  if (!text || isDateLike(text) || isTimeLike(text) || isPlateLike(text)) return false;
  if (/^\d{4,7}$/.test(text)) return true;
  return /^[A-Z0-9-]{4,12}$/i.test(text) && /\d/.test(text);
}

function looksLikeProduct(value) {
  return /^(AGO|MGR|PMS|JET|DPK|LPG|KEROSENE|DIESEL|GASOIL|GASOLINE)$/i.test(cleanCell(value));
}

function looksLikeCompany(value) {
  const text = cleanCell(value);
  if (!text || isDateLike(text) || isTimeLike(text) || isPlateLike(text) || isArrivalCodeLike(text) || looksLikeProduct(text)) return false;
  return /[A-Z]/i.test(text);
}

function pickNearbyCell(cells, startIndex, predicate, usedIndexes) {
  const indexes = cells.map((_, index) => index)
    .filter((index) => index !== startIndex && !usedIndexes.has(index))
    .sort((a, b) => Math.abs(a - startIndex) - Math.abs(b - startIndex) || a - b);

  return indexes.find((index) => predicate(cells[index]));
}

function pickArrivalCodeCell(cells, plateIndex, usedIndexes) {
  const rightSideCode = cells.findIndex((cell, index) =>
    index > plateIndex && !usedIndexes.has(index) && isArrivalCodeLike(cell)
  );

  return rightSideCode >= 0
    ? rightSideCode
    : pickNearbyCell(cells, plateIndex, isArrivalCodeLike, usedIndexes);
}

function parseArrivalRow(row, arrivalDate, batchTime) {
  const cells = (Array.isArray(row) ? row : []).map(cleanCell);
  if (!cells.some(Boolean)) return null;

  const targetIndex = cells.findIndex((cell) => findMatchingTargetPlate(cell) !== null);
  const plateIndex = targetIndex >= 0 ? targetIndex : cells.findIndex(isPlateLike);
  if (plateIndex < 0) return null;

  const matchedTargetPlate = targetIndex >= 0 ? findMatchingTargetPlate(cells[targetIndex]) : null;

  const usedIndexes = new Set([plateIndex]);
  let codeIndex = pickArrivalCodeCell(cells, plateIndex, usedIndexes);
  if (codeIndex !== undefined) usedIndexes.add(codeIndex);

  const dateIndex = pickNearbyCell(cells, plateIndex, isDateLike, usedIndexes);
  if (dateIndex !== undefined) usedIndexes.add(dateIndex);

  const timeIndex = pickNearbyCell(cells, plateIndex, isTimeLike, usedIndexes);
  if (timeIndex !== undefined) usedIndexes.add(timeIndex);

  const productIndex = pickNearbyCell(cells, plateIndex, looksLikeProduct, usedIndexes);
  if (productIndex !== undefined) usedIndexes.add(productIndex);

  const companyIndex = pickNearbyCell(cells, plateIndex, looksLikeCompany, usedIndexes);
  if (companyIndex !== undefined) usedIndexes.add(companyIndex);

  if (codeIndex === undefined) {
    codeIndex = pickFallbackCell(cells, usedIndexes);
    if (codeIndex !== undefined) usedIndexes.add(codeIndex);
  }

  return {
    arrival_date: dateIndex !== undefined ? toIsoDate(cells[dateIndex]) || arrivalDate : arrivalDate,
    batch_time: timeIndex !== undefined ? cells[timeIndex].slice(0, 5) : batchTime,
    license_plate: matchedTargetPlate || cells[plateIndex],
    arrival_code: codeIndex !== undefined ? cells[codeIndex] : "",
    product_type: productIndex !== undefined ? cells[productIndex] : null,
    company: companyIndex !== undefined ? cells[companyIndex] : null,
  };
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

  if (!workbook.SheetNames || !workbook.SheetNames.length) {
    return res.redirect(302, "/?from=shortcut&status=error");
  }

  const now = new Date();
  const arrival_date = formatDate(now);
  const batch_time = formatTime(now);

  const allRows = [];
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    if (!matrix.length) return;

    const rows = matrix
      .map((row) => parseArrivalRow(row, arrival_date, batch_time))
      .filter(Boolean);

    allRows.push(...rows);
  });

  const targetRows = TARGET_LICENSE_PLATES.flatMap((plate) => {
    const targetPlate = normalizePlate(plate);
    return allRows
      .filter((row) => normalizePlate(row.license_plate) === targetPlate)
      .map((row) => ({
        arrival_date: row.arrival_date,
        batch_time: row.batch_time,
        license_plate: targetPlate,
        arrival_code: row.arrival_code,
        product_type: row.product_type || null,
        company: row.company || null,
      }));
  });

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
