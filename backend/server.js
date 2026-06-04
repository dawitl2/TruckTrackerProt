require("dotenv").config();

const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const TARGET_REFERENCE = "FT00211QWBK0";
const TABLE_NAME = "bank_transactions";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY ||
  "";

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const fallbackArrivals = new Map();
const frontendBuildPath = path.join(__dirname, "..", "frontend", "build");

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const COLUMN_ALIASES = {
  reference: [
    "reference",
    "ref",
    "referencecode",
    "transactionref",
    "transactionid",
    "voucher",
    "trackingid",
    "id"
  ],
  date: ["date", "transactiondate", "postingdate", "value date"],
  narrative: ["narrative", "particulars", "description", "details", "memo", "remarks"],
  debit: ["debit", "dr", "withdrawal"],
  credit: ["credit", "cr", "deposit"],
  balance: ["balance", "closingbalance", "runningbalance"]
};

function normalizeKey(key) {
  return String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNumber(value) {
  const text = normalizeText(value);

  if (!text) {
    return "";
  }

  const parsed = Number(text.replace(/[^0-9.-]/g, ""));

  return Number.isFinite(parsed) ? parsed : text;
}

function pickValue(row, aliases) {
  const keys = Object.keys(row || {});
  const normalizedAliases = aliases.map(normalizeKey);
  const matchKey = keys.find((key) => {
    const normalized = normalizeKey(key);
    return normalizedAliases.some(
      (alias) => normalized === alias || normalized.includes(alias)
    );
  });

  if (!matchKey) {
    return "";
  }

  return normalizeText(row[matchKey]);
}

function isReferenceColumn(key) {
  const normalized = normalizeKey(key);

  return (
    normalized.includes("reference") ||
    normalized === "ref" ||
    normalized.includes("transactionref") ||
    normalized.includes("transactionid") ||
    normalized.includes("trackingid") ||
    normalized.includes("voucher") ||
    normalized === "id"
  );
}

function pickUploadedFile(req) {
  if (req.file) {
    return req.file;
  }

  if (Array.isArray(req.files) && req.files.length > 0) {
    return req.files[0];
  }

  if (req.files && typeof req.files === "object") {
    const firstGroup = Object.values(req.files).flat();
    if (firstGroup.length > 0) {
      return firstGroup[0];
    }
  }

  return null;
}

function readWorkbookFromFile(file) {
  const name = normalizeText(file.originalname).toLowerCase();
  const mimeType = normalizeText(file.mimetype).toLowerCase();
  const isTextFile =
    name.endsWith(".csv") ||
    name.endsWith(".txt") ||
    mimeType.includes("csv") ||
    mimeType.startsWith("text/");

  if (isTextFile) {
    return xlsx.read(file.buffer.toString("utf8"), { type: "string" });
  }

  return xlsx.read(file.buffer, { type: "buffer" });
}

function rowMatchesReference(row, targetReference) {
  const target = normalizeText(targetReference).toLowerCase();

  if (!target) {
    return true;
  }

  const keys = Object.keys(row || {});
  const columnsToCheck = keys.filter(isReferenceColumn);
  const searchColumns = columnsToCheck.length ? columnsToCheck : keys;

  return searchColumns.some((key) => {
    const value = normalizeText(row[key]).toLowerCase();
    return value === target;
  });
}

function mapRow(row, sourceFile, targetReference, rowIndex) {
  const reference =
    pickValue(row, COLUMN_ALIASES.reference) || normalizeText(targetReference);

  if (!reference) {
    return null;
  }

  return {
    id: randomUUID(),
    date: pickValue(row, COLUMN_ALIASES.date),
    reference,
    narrative: pickValue(row, COLUMN_ALIASES.narrative),
    debit: normalizeNumber(pickValue(row, COLUMN_ALIASES.debit)),
    credit: normalizeNumber(pickValue(row, COLUMN_ALIASES.credit)),
    balance: normalizeNumber(pickValue(row, COLUMN_ALIASES.balance)),
    source_file: sourceFile,
    raw_row: row,
    row_index: rowIndex
  };
}

function extractRecords(rows, sourceFile, targetReference) {
  const trimmedTarget = normalizeText(targetReference);

  return rows
    .filter((row) => {
      if (trimmedTarget) {
        return rowMatchesReference(row, trimmedTarget);
      }

      return Object.values(row || {}).some((value) => normalizeText(value));
    })
    .map((row, index) => mapRow(row, sourceFile, trimmedTarget, index))
    .filter(Boolean);
}

async function persistArrivals(records) {
  if (!records.length) {
    return [];
  }

  const payload = records.map(({ raw_row, row_index, ...record }) => record);

  if (supabase) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .upsert(payload, { onConflict: "reference" })
      .select("*");

    if (error) {
      throw error;
    }

    return data || payload;
  }

  const savedRecords = payload.map((record) => {
    const stored = {
      ...record,
      id: randomUUID(),
      created_at: new Date().toISOString()
    };

    fallbackArrivals.set(record.reference, stored);
    return stored;
  });

  return savedRecords;
}

async function loadArrivals(limit = 12) {
  const pageSize = Number(limit) || 12;

  if (supabase) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(pageSize);

    if (error) {
      throw error;
    }

    return data || [];
  }

  return Array.from(fallbackArrivals.values())
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, pageSize);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "truck-tracker",
    database: supabase ? "supabase" : "memory"
  });
});

app.get("/api/arrivals", async (req, res) => {
  try {
    const rows = await loadArrivals(req.query.limit);

    res.json({
      ok: true,
      rows
    });
  } catch (error) {
    console.error("Failed to load arrivals:", error);
    res.status(500).json({
      error: "Failed to load arrivals"
    });
  }
});

app.post("/api/arrivals", async (req, res) => {
  try {
    const body = req.body || {};
    const reference = normalizeText(body.reference);

    if (!reference) {
      return res.status(400).json({
        error: "Reference is required"
      });
    }

    const record = {
      id: randomUUID(),
      date: normalizeText(body.date),
      reference,
      narrative: normalizeText(body.narrative || body.particulars),
      debit: normalizeNumber(body.debit),
      credit: normalizeNumber(body.credit),
      balance: normalizeNumber(body.balance),
      source_file: normalizeText(body.source_file || body.sourceFile || "manual"),
      raw_row: body.raw_row || null
    };

    const saved = await persistArrivals([record]);

    res.status(201).json({
      ok: true,
      row: saved[0]
    });
  } catch (error) {
    console.error("Failed to save arrival:", error);
    res.status(500).json({
      error: "Failed to save arrival"
    });
  }
});

app.post("/api/import", upload.any(), async (req, res) => {
  try {
    const file = pickUploadedFile(req);
    const targetReference = TARGET_REFERENCE;

    if (!file) {
      return res.status(400).json({
        error: "No file uploaded"
      });
    }

    const workbook = readWorkbookFromFile(file);
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      return res.status(400).json({
        error: "The uploaded workbook does not contain any sheets"
      });
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet, {
      defval: "",
      raw: false
    });

    if (!rows.length) {
      return res.status(400).json({
        error: "No data rows were found in the uploaded file"
      });
    }

    const records = extractRecords(rows, file.originalname || "uploaded-file", targetReference);

    if (!records.length) {
      return res.status(404).json({
        ok: false,
        message: "No matching reference was found",
        importedCount: 0,
        savedCount: 0,
        rows: []
      });
    }

    res.json({
      ok: true,
      message: "Reference matched",
      importedCount: records.length,
      savedCount: 0,
      rows: records,
      arrivals: await loadArrivals(12)
    });
  } catch (error) {
    console.error("Failed to import file:", error);
    res.status(500).json({
      error: "Failed to import file"
    });
  }
});

if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));

  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(frontendBuildPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Truck Tracker API listening on port ${PORT}`);
  if (!supabase) {
    console.log("Supabase env vars are missing. Running with in-memory storage.");
  }
});
