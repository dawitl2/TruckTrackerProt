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
const TRUCK_ARRIVALS_TABLE = "truck_arrivals";
const TARGET_LICENSE_PLATES = ["A06725/32431", "A09321/32699"];
const TARGET_LICENSE_PLATE_SET = new Set(TARGET_LICENSE_PLATES.map(normalizePlateValue));

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

function normalizePlateValue(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA").format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function cleanTruckCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isTruckDateLike(value) {
  const text = cleanTruckCell(value);
  return /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(text) || /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(text);
}

function toTruckIsoDate(value) {
  const text = cleanTruckCell(value);
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

function isTruckTimeLike(value) {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanTruckCell(value));
}

function isTruckPlateLike(value) {
  const plate = normalizePlateValue(value);
  return TARGET_LICENSE_PLATE_SET.has(plate) || /^[A-Z]?\d{4,6}\/\d{4,6}$/.test(plate);
}

function isTruckArrivalCodeLike(value) {
  const text = cleanTruckCell(value);
  if (!text || isTruckDateLike(text) || isTruckTimeLike(text) || isTruckPlateLike(text)) return false;
  if (/^\d{4,7}$/.test(text)) return true;
  return /^[A-Z0-9-]{4,12}$/i.test(text) && /\d/.test(text);
}

function looksLikeTruckProduct(value) {
  return /^(AGO|MGR|PMS|JET|DPK|LPG|KEROSENE|DIESEL|GASOIL|GASOLINE)$/i.test(cleanTruckCell(value));
}

function looksLikeTruckCompany(value) {
  const text = cleanTruckCell(value);
  if (!text || isTruckDateLike(text) || isTruckTimeLike(text) || isTruckPlateLike(text) || isTruckArrivalCodeLike(text) || looksLikeTruckProduct(text)) return false;
  return /[A-Z]/i.test(text);
}

function pickNearbyTruckCell(cells, startIndex, predicate, usedIndexes) {
  const indexes = cells.map((_, index) => index)
    .filter((index) => index !== startIndex && !usedIndexes.has(index))
    .sort((a, b) => Math.abs(a - startIndex) - Math.abs(b - startIndex) || a - b);

  return indexes.find((index) => predicate(cells[index]));
}

function pickTruckArrivalCodeCell(cells, plateIndex, usedIndexes) {
  const rightSideCode = cells.findIndex((cell, index) =>
    index > plateIndex && !usedIndexes.has(index) && isTruckArrivalCodeLike(cell)
  );

  return rightSideCode >= 0
    ? rightSideCode
    : pickNearbyTruckCell(cells, plateIndex, isTruckArrivalCodeLike, usedIndexes);
}

function parseTruckArrivalRow(row, arrivalDate, batchTime) {
  const cells = (Array.isArray(row) ? row : []).map(cleanTruckCell);
  if (!cells.some(Boolean)) return null;

  const targetIndex = cells.findIndex((cell) => TARGET_LICENSE_PLATE_SET.has(normalizePlateValue(cell)));
  const plateIndex = targetIndex >= 0 ? targetIndex : cells.findIndex(isTruckPlateLike);
  if (plateIndex < 0) return null;

  const usedIndexes = new Set([plateIndex]);
  const codeIndex = pickTruckArrivalCodeCell(cells, plateIndex, usedIndexes);
  if (codeIndex === undefined) return null;
  usedIndexes.add(codeIndex);

  const dateIndex = pickNearbyTruckCell(cells, plateIndex, isTruckDateLike, usedIndexes);
  if (dateIndex !== undefined) usedIndexes.add(dateIndex);

  const timeIndex = pickNearbyTruckCell(cells, plateIndex, isTruckTimeLike, usedIndexes);
  if (timeIndex !== undefined) usedIndexes.add(timeIndex);

  const productIndex = pickNearbyTruckCell(cells, plateIndex, looksLikeTruckProduct, usedIndexes);
  if (productIndex !== undefined) usedIndexes.add(productIndex);

  const companyIndex = pickNearbyTruckCell(cells, plateIndex, looksLikeTruckCompany, usedIndexes);

  return {
    arrival_date: dateIndex !== undefined ? toTruckIsoDate(cells[dateIndex]) || arrivalDate : arrivalDate,
    batch_time: timeIndex !== undefined ? cells[timeIndex].slice(0, 5) : batchTime,
    license_plate: cells[plateIndex],
    arrival_code: cells[codeIndex],
    product_type: productIndex !== undefined ? cells[productIndex] : null,
    company: companyIndex !== undefined ? cells[companyIndex] : null
  };
}

function shortcutPayload(rows) {
  const payloadRows = rows.map((row, index) => ({
    id: String(row.id || `local-${index}`),
    license_plate: row.license_plate || "",
    arrival_code: row.arrival_code || "",
    arrival_date: row.arrival_date || "",
    batch_time: row.batch_time || ""
  }));

  return Buffer.from(JSON.stringify(payloadRows)).toString("base64url");
}

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true
  })
);

// GPS Live Tracking Reverse Proxy Middleware to bypass Same-Origin Policy
app.use((req, res, next) => {
  const isGpsProxy = req.url.startsWith("/gps-proxy");
  const isRefererGps = req.headers.referer && req.headers.referer.includes("/gps-proxy/");
  const isExplicitAsset = req.url.startsWith("/assets/") || req.url.startsWith("/vts-tabicon") || req.url.startsWith("/polyfills-legacy");

  if (isGpsProxy || isRefererGps || isExplicitAsset) {
    let targetPath = req.url;
    if (targetPath.startsWith("/gps-proxy")) {
      targetPath = targetPath.replace("/gps-proxy", "");
      if (!targetPath.startsWith("/")) {
        targetPath = "/" + targetPath;
      }
    }

    const https = require("https");
    const options = {
      hostname: "gps2.ztrackinsight.com",
      port: 443,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: "gps2.ztrackinsight.com",
        referer: "https://gps2.ztrackinsight.com/tracking",
        origin: "https://gps2.ztrackinsight.com"
      }
    };

    // Remove headers that might cause security or redirection issues
    delete options.headers["sec-fetch-site"];
    delete options.headers["sec-fetch-mode"];
    delete options.headers["sec-fetch-dest"];
    
    // Disable compression so we can intercept and parse HTML as plain text
    delete options.headers["accept-encoding"];

    const proxyReq = https.request(options, (proxyRes) => {
      // Clean up framing restriction headers so the browser allows the iframe to render
      delete proxyRes.headers["x-frame-options"];
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["x-content-type-options"];

      // Rewrite Set-Cookie domains to allow localhost session persistence
      if (proxyRes.headers["set-cookie"]) {
        const cookies = proxyRes.headers["set-cookie"].map((cookie) => {
          return cookie
            .replace(/Domain=[^;]+;?\s*/gi, "")
            .replace(/Secure;?\s*/gi, "");
        });
        proxyRes.headers["set-cookie"] = cookies;
      }

      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      if (isHtml) {
        let body = "";
        proxyRes.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        proxyRes.on("end", () => {
          // Automation script to inject inside the iframe same-origin context
          const scriptToInject = `
<script>
(function() {
  console.log("GPS Auto-Login & Navigation Script Active");
  
  // Post initial status
  window.parent.postMessage({ type: 'GPS_STATUS', status: 'Connecting...' }, '*');
  
  // Get plate from query params
  const urlParams = new URLSearchParams(window.location.search);
  const targetPlate = urlParams.get('plate');
  console.log("Target vehicle plate:", targetPlate);

  const setNativeValue = (element, value) => {
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  };

  let searchAttempts = 0;

  const intervalId = setInterval(() => {
    try {
      // 1. Check for Login page
      const usernameInput = document.getElementById("username");
      const passwordInput = document.getElementById("password");
      const submitBtn = document.querySelector("button[type='submit']");

      if (usernameInput && passwordInput && submitBtn) {
        window.parent.postMessage({ type: 'GPS_STATUS', status: 'Logging in...' }, '*');
        if (usernameInput.value !== "enkua") {
          setNativeValue(usernameInput, "enkua");
          usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (passwordInput.value !== "E3456789") {
          setNativeValue(passwordInput, "E3456789");
          passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
        }

        if (usernameInput.value === "enkua" && passwordInput.value === "E3456789") {
          console.log("Submitting login form...");
          window.parent.postMessage({ type: 'GPS_STATUS', status: 'Authenticating...' }, '*');
          submitBtn.click();
        }
        return;
      }

      // 2. Check for Dashboard and search input
      const searchInput = document.querySelector("input[placeholder*='Search']");
      if (searchInput && targetPlate) {
        if (window.__lastSelectedPlate !== targetPlate) {
          window.parent.postMessage({ type: 'GPS_STATUS', status: 'Locating vehicle...' }, '*');
          if (searchInput.value !== targetPlate) {
            setNativeValue(searchInput, targetPlate);
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          }

          // Click the matching vehicle button
          const buttons = Array.from(document.querySelectorAll("button"));
          const match = buttons.find(b => b.textContent && b.textContent.includes(targetPlate));
          if (match) {
            match.click();
            window.__lastSelectedPlate = targetPlate;
            console.log("Clicked matching vehicle:", targetPlate);
            window.parent.postMessage({ type: 'GPS_STATUS', status: 'Live Tracking' }, '*');
          } else {
            searchAttempts++;
            if (searchAttempts > 15) {
              window.parent.postMessage({ type: 'GPS_STATUS', status: 'Vehicle not found' }, '*');
            }
          }
        } else {
          window.parent.postMessage({ type: 'GPS_STATUS', status: 'Live Tracking' }, '*');
        }
        
        // 3. Switch to Satellite View
        const layersToggle = document.querySelector('.leaflet-control-layers-toggle');
        if (layersToggle && !window.__switchedToSatellite) {
          // Open layers control
          layersToggle.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          layersToggle.click();
          
          setTimeout(() => {
            const selectors = Array.from(document.querySelectorAll('.leaflet-control-layers-selector, label, span'));
            const satLabel = selectors.find(el => {
              const text = el.textContent?.toLowerCase() || '';
              return text.includes('sat') || text.includes('hyb') || text.includes('aerial') || text.includes('sate');
            });
            
            if (satLabel) {
              const input = satLabel.tagName === 'INPUT' ? satLabel : satLabel.querySelector('input') || satLabel.parentElement.querySelector('input');
              if (input && !input.checked) {
                input.click();
                window.__switchedToSatellite = true;
                console.log("Switched to satellite view");
              } else if (satLabel.tagName !== 'INPUT') {
                satLabel.click();
                window.__switchedToSatellite = true;
                console.log("Clicked satellite label");
              }
            }
          }, 500);
        }
      }
    } catch (err) {
      console.error("Auto-login script error:", err);
      window.parent.postMessage({ type: 'GPS_STATUS', status: 'Error' }, '*');
    }
  }, 1000);
})();
</script>
`;
          const injectedBody = body.replace(/<\/body>/i, `${scriptToInject}</body>`);
          
          if (proxyRes.headers["content-length"]) {
            proxyRes.headers["content-length"] = Buffer.byteLength(injectedBody);
          }
          
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(injectedBody);
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    });

    proxyReq.on("error", (err) => {
      console.error("GPS Proxy Error:", err);
      res.status(500).send("GPS Proxy error: " + err.message);
    });

    req.pipe(proxyReq, { end: true });
  } else {
    next();
  }
});

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

    if (!file) {
      return res.redirect(302, "/?from=shortcut&status=error");
    }

    const workbook = readWorkbookFromFile(file);
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      return res.redirect(302, "/?from=shortcut&status=error");
    }

    const worksheet = workbook.Sheets[sheetName];
    const matrix = xlsx.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: false
    });

    const now = new Date();
    const arrivalDate = formatDate(now);
    const batchTime = formatTime(now);

    const targetRows = matrix
      .map((row) => parseTruckArrivalRow(row, arrivalDate, batchTime))
      .filter((row) => row && TARGET_LICENSE_PLATE_SET.has(normalizePlateValue(row.license_plate)));

    if (!targetRows.length) {
      return res.redirect(302, "/?from=shortcut&status=not_found");
    }

    if (!supabase) {
      const payload = shortcutPayload(targetRows);
      return res.redirect(302, `/?from=shortcut&status=db_error&rows=${payload}`);
    }

    const { data, error } = await supabase
      .from(TRUCK_ARRIVALS_TABLE)
      .insert(targetRows)
      .select("id,license_plate,arrival_code,arrival_date,batch_time");

    if (error) {
      console.error("Supabase truck arrival import error:", error);
      const payload = shortcutPayload(targetRows);
      return res.redirect(302, `/?from=shortcut&status=db_error&rows=${payload}`);
    }

    const payload = shortcutPayload(data || targetRows);
    return res.redirect(302, `/?from=shortcut&status=saved&rows=${payload}`);
  } catch (error) {
    console.error("Failed to import truck arrival file:", error);
    return res.redirect(302, "/?from=shortcut&status=error");
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
