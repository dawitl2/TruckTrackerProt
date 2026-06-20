require("dotenv").config();

const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 5000;
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;

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
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        realtime: {
          transport: WebSocket
        }
      })
    : null;

const fallbackArrivals = new Map();
const frontendBuildPath = path.join(__dirname, "..", "frontend", "build");

function normalizeKeepAliveUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    const url = new URL(text);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/api/health";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function getKeepAliveUrl() {
  return normalizeKeepAliveUrl(
    process.env.KEEP_ALIVE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  );
}

function startKeepAlive() {
  const keepAliveUrl = getKeepAliveUrl();
  if (!keepAliveUrl) return;

  const ping = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(keepAliveUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "TruckTracker-KeepAlive/1.0"
        }
      });

      console.log(`Keep-alive ping ${response.status}: ${keepAliveUrl}`);
    } catch (error) {
      console.warn(`Keep-alive ping failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  };

  setTimeout(ping, 60 * 1000);
  setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
}

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
  window.parent.postMessage({ type: 'GPS_STATUS', status: 'Connecting...' }, '*');

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

  const toNumber = (value) => {
    const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : null;
  };

  const isValidCoordinate = (latitude, longitude) => (
    latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
  );

  const compactPlateText = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const textMatchesTargetPlate = (text) => {
    const source = String(text || "");
    return Boolean(targetPlate && (source.includes(targetPlate) || compactPlateText(source).includes(compactPlateText(targetPlate))));
  };

  // The vehicle marker shows its plate as plain text right on the map —
  // we don't need to search or open a popup to find it.
  const findMarkerElement = () => {
    const markers = Array.from(document.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon"));
    return markers.find((el) => textMatchesTargetPlate(el.textContent)) || null;
  };

  // Tile <img> src URLs encode zoom/x/y (e.g. ".../16/40535/30731.png"),
  // which is enough to turn a marker's screen position into real lat/lng.
  const parseTileUrl = (src) => {
    const text = String(src || "").split("?")[0];
    const dot = text.lastIndexOf(".");
    if (dot === -1) return null;
    const ext = text.slice(dot + 1).toLowerCase();
    if (ext !== "png" && ext !== "jpg" && ext !== "jpeg") return null;
    const parts = text.slice(0, dot).split("/");
    if (parts.length < 3) return null;
    const tileY = parseInt(parts[parts.length - 1], 10);
    const tileX = parseInt(parts[parts.length - 2], 10);
    const zoom = parseInt(parts[parts.length - 3], 10);
    if (!Number.isFinite(zoom) || !Number.isFinite(tileX) || !Number.isFinite(tileY)) return null;
    return { zoom, tileX, tileY };
  };

  const findReferenceTile = () => {
    const containers = Array.from(document.querySelectorAll(".leaflet-tile-pane .leaflet-tile-container"))
      .map((el) => ({ el, z: parseInt(el.style.zIndex || "0", 10) || 0 }))
      .sort((a, b) => b.z - a.z);

    for (const { el } of containers) {
      const images = Array.from(el.querySelectorAll("img"));
      for (const img of images) {
        const tile = parseTileUrl(img.getAttribute("src"));
        if (!tile) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return { ...tile, rect };
      }
    }
    return null;
  };

  // getBoundingClientRect() already bakes in every ancestor CSS transform
  // (pan, zoom-scale, zoom animation), so this stays correct without us
  // having to reverse-engineer Leaflet's internal pane transforms.
  const markerLatLngFromTile = (markerEl, referenceTile) => {
    if (!markerEl || !referenceTile) return null;
    const markerRect = markerEl.getBoundingClientRect();
    if (!markerRect.width || !markerRect.height) return null;

    const anchorX = markerRect.left + markerRect.width / 2;
    const anchorY = markerRect.top + markerRect.height / 2;
    const worldPxPerScreenX = 256 / referenceTile.rect.width;
    const worldPxPerScreenY = 256 / referenceTile.rect.height;

    const worldX = referenceTile.tileX * 256 + (anchorX - referenceTile.rect.left) * worldPxPerScreenX;
    const worldY = referenceTile.tileY * 256 + (anchorY - referenceTile.rect.top) * worldPxPerScreenY;

    const n = Math.pow(2, referenceTile.zoom);
    const longitude = (worldX / (256 * n)) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / (256 * n))));
    const latitude = (latRad * 180) / Math.PI;

    return isValidCoordinate(latitude, longitude) ? { latitude, longitude } : null;
  };

  // The arrow SVG already draws its heading as transform: rotate(NNdeg) —
  // 0deg = north, clockwise — so we read it instead of guessing from deltas.
  const markerHeadingFromSvg = (markerEl) => {
    const svg = markerEl && markerEl.querySelector("svg");
    if (!svg) return null;
    const styleAttr = svg.getAttribute("style") || "";
    const start = styleAttr.indexOf("rotate(");
    if (start === -1) return null;
    const end = styleAttr.indexOf(")", start);
    if (end === -1) return null;
    const deg = parseFloat(styleAttr.slice(start + 7, end));
    return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null;
  };

  // Kept as a refinement layer: if a popup happens to be open (e.g. after
  // our click below), its exact reported coordinates win over the
  // tile-geometry estimate.
  const parseCoordinateText = (text) => {
    const source = String(text || "").replace(/\\s+/g, " ");
    const explicitCopyMatch = source.match(/handleCopyCoords\\([^0-9-]*(-?\\d{1,2}\\.\\d{3,})\\s*,\\s*(-?\\d{1,3}\\.\\d{3,})/i);
    const match = explicitCopyMatch || source.match(/(?:Coordinates\\s*)?(-?\\d{1,2}\\.\\d{3,})\\s*(?:\\u00b0)?\\s*([NS])?[,\\s]+(-?\\d{1,3}\\.\\d{3,})\\s*(?:\\u00b0)?\\s*([EW])?/i);
    if (!match) return null;

    let latitude = toNumber(match[1]);
    let longitude = toNumber(explicitCopyMatch ? match[2] : match[3]);
    if (!explicitCopyMatch && match[2] && match[2].toUpperCase() === "S") latitude = -Math.abs(latitude);
    if (!explicitCopyMatch && match[4] && match[4].toUpperCase() === "W") longitude = -Math.abs(longitude);

    return isValidCoordinate(latitude, longitude) ? { latitude, longitude } : null;
  };

  const parseHeadingText = (text) => {
    const match = String(text || "").match(/(?:heading|course|bearing|direction|angle)[^0-9]{0,16}(\\d{1,3}(?:\\.\\d+)?)/i);
    const heading = match ? toNumber(match[1]) : null;
    return heading !== null ? ((heading % 360) + 360) % 360 : null;
  };

  const getPopupLocationLabel = (text) => {
    const source = String(text || "").replace(/\\s+/g, " ");
    const match = source.match(/Location\\s+(.+?)\\s+(?:Timestamp|Company|Driver|Driver Phone|Device Phone|Device IMEI|Coordinates|Follow|History|Best View|Stoppages|$)/i);
    return match ? match[1].trim().slice(0, 220) : "";
  };

  const clickLikeUser = (element) => {
    if (!element) return false;
    ["mouseover", "mousedown", "mouseup", "click"].forEach((type) => {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  };

  const closeAlertPanels = () => {
    const alertWords = ["alert", "alerts", "alarm", "alarms", "notification", "details"];
    const hasAlertText = (element) => {
      const text = (element?.textContent || "").toLowerCase();
      return alertWords.some((word) => text.includes(word));
    };

    const closeButtons = Array.from(document.querySelectorAll(
      "button[aria-label*='Close'], button[aria-label*='close'], button[title*='Close'], button[title*='close'], button"
    ));

    closeButtons.forEach((button) => {
      const label = ((button.getAttribute("aria-label") || "") + " " + (button.getAttribute("title") || "") + " " + (button.textContent || "")).toLowerCase();
      const area = button.closest("[role='dialog'], [data-vaul-drawer], aside, section, .drawer, .modal, div");
      const isCloseButton = label.includes("close") || label === "x" || label === "×" || label === "✕";

      if (isCloseButton && area && hasAlertText(area) && !area.querySelector(".leaflet-container")) {
        button.click();
      }
    });

    Array.from(document.querySelectorAll("[role='dialog'], [data-vaul-drawer], aside, .drawer, .modal")).forEach((panel) => {
      if (panel.querySelector(".leaflet-container")) return;
      if (hasAlertText(panel)) {
        panel.style.display = "none";
        panel.setAttribute("aria-hidden", "true");
      }
    });
  };

  // The site's "Layers" control is a custom button (lucide-layers icon),
  // not Leaflet's built-in .leaflet-control-layers-toggle.
  const findLayersToggleButton = () => {
    const icon = document.querySelector("svg.lucide-layers");
    return icon ? icon.closest("button") : null;
  };

  const attemptSatelliteSwitch = () => {
    if (window.__switchedToSatellite) return;
    const toggle = findLayersToggleButton();
    if (!toggle) return;
    toggle.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    toggle.click();
    setTimeout(() => {
      const candidates = Array.from(document.querySelectorAll("button, [role='menuitem'], [role='option'], li, label, span"));
      const match = candidates.find((el) => {
        const text = (el.textContent || "").toLowerCase();
        return text.indexOf("satellite") !== -1 || text.indexOf("hybrid") !== -1 || text.indexOf("aerial") !== -1;
      });
      if (match) {
        match.click();
        window.__switchedToSatellite = true;
      }
    }, 450);
  };

  let searchAttempts = 0;
  let lastClickedPlate = null;

  const tick = () => {
    try {
      closeAlertPanels();

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
          window.parent.postMessage({ type: 'GPS_STATUS', status: 'Authenticating...' }, '*');
          submitBtn.click();
        }
        return;
      }

      if (!targetPlate) {
        window.parent.postMessage({ type: 'GPS_STATUS', status: 'Missing plate' }, '*');
        return;
      }

      const markerEl = findMarkerElement();

      if (!markerEl) {
        searchAttempts++;
        window.parent.postMessage({
          type: 'GPS_STATUS',
          status: searchAttempts > 20 ? 'Vehicle not found' : 'Locating vehicle...'
        }, '*');
        return;
      }

      searchAttempts = 0;

      if (lastClickedPlate !== targetPlate) {
        clickLikeUser(markerEl);
        lastClickedPlate = targetPlate;
        setTimeout(closeAlertPanels, 250);
        setTimeout(closeAlertPanels, 900);
        attemptSatelliteSwitch();
      }

      const referenceTile = findReferenceTile();
      const fromTile = referenceTile ? markerLatLngFromTile(markerEl, referenceTile) : null;
      const svgHeading = markerHeadingFromSvg(markerEl);

      const popupText = Array.from(document.querySelectorAll(".leaflet-popup-content, .custom-vehicle-popup, .leaflet-popup"))
        .map((element) => [
          element.innerText,
          element.textContent,
          Array.from(element.querySelectorAll("[onclick]")).map((node) => node.getAttribute("onclick")).join(" ")
        ].filter(Boolean).join(" "))
        .find((text) => textMatchesTargetPlate(text) || /Coordinates/i.test(text));

      const popupCoords = popupText ? parseCoordinateText(popupText) : null;
      const finalCoords = popupCoords || fromTile;

      if (finalCoords) {
        const finalHeading = svgHeading !== null ? svgHeading : (popupText ? parseHeadingText(popupText) : null);

        window.parent.postMessage({
          type: 'GPS_LOCATION',
          latitude: finalCoords.latitude,
          longitude: finalCoords.longitude,
          heading: finalHeading,
          label: popupText ? getPopupLocationLabel(popupText) : ""
        }, '*');
        window.parent.postMessage({ type: 'GPS_STATUS', status: 'Live Tracking' }, '*');
      } else {
        window.parent.postMessage({ type: 'GPS_STATUS', status: 'Locating vehicle...' }, '*');
      }
    } catch (err) {
      console.error("Auto-login script error:", err);
      window.parent.postMessage({ type: 'GPS_STATUS', status: 'Error' }, '*');
    }
  };

  const intervalId = setInterval(tick, 1000);
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
  startKeepAlive();
});
