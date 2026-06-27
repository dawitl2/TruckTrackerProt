import { useEffect, useRef, useState } from "react";
import "./GpsTrackingPanel.css";

const GPS_PROXY_ORIGIN = process.env.NODE_ENV === "development" ? "http://localhost:5000" : "";
const GPS_PROXY_PATH = "/gps-proxy";
const ROUTE_SPEED_KMH = 70;

const ROUTE_NODES = {
  start: {
    name: "TotalEnergies Bole Road Service Station",
    shortName: "Bole Road",
    location: "Bole, Addis Ababa, Ethiopia",
    latitude: 9.0012,
    longitude: 38.7857
  },
  destination: {
    name: "Horizon Djibouti Terminals Limited (HDTL)",
    shortName: "HDTL",
    location: "Doraleh Port, Djibouti City, Djibouti",
    latitude: 11.59,
    longitude: 43.08
  }
};

const ROUTE_WAYPOINTS = [
  { name: "Bole, Addis Ababa", country: "Ethiopia", latitude: 9.0012, longitude: 38.7857 },
  { name: "Dukem", country: "Ethiopia", latitude: 8.8, longitude: 38.9 },
  { name: "Bishoftu", country: "Ethiopia", latitude: 8.7523, longitude: 38.9785 },
  { name: "Mojo", country: "Ethiopia", latitude: 8.5868, longitude: 39.1211 },
  { name: "Adama", country: "Ethiopia", latitude: 8.5410, longitude: 39.2690 },
  { name: "Welenchiti", country: "Ethiopia", latitude: 8.67, longitude: 39.44 },
  { name: "Metehara", country: "Ethiopia", latitude: 8.9, longitude: 39.9167 },
  { name: "Awash", country: "Ethiopia", latitude: 8.9833, longitude: 40.1667 },
  { name: "Gewane", country: "Ethiopia", latitude: 10.1667, longitude: 40.65 },
  { name: "Mille", country: "Ethiopia", latitude: 11.4127, longitude: 40.9751 },
  { name: "Logiya", country: "Ethiopia", latitude: 11.5280, longitude: 40.9640 },
  { name: "Semera", country: "Ethiopia", latitude: 11.7934, longitude: 41.0058 },
  { name: "Serdo", country: "Ethiopia", latitude: 11.708, longitude: 41.245 },
  { name: "Galafi Border", country: "Djibouti", latitude: 11.7167, longitude: 41.8667 },
  { name: "Yoboki", country: "Djibouti", latitude: 11.507, longitude: 42.103 },
  { name: "Dikhil", country: "Djibouti", latitude: 11.1046, longitude: 42.3722 },
  { name: "Arta", country: "Djibouti", latitude: 11.5264, longitude: 42.8478 },
  { name: "Doraleh Port", country: "Djibouti", latitude: 11.59, longitude: 43.08 }
];

export function getMapPlateFormat(plate) {
  const norm = normalizePlate(plate);
  if (norm.includes("A06725")) return "3-A06725/3-32431";
  if (norm.includes("A09321")) return "3-A09321/3-32669";
  const parts = norm.split("/");
  if (parts.length === 2) return `3-${parts[0]}/3-${parts[1]}`;
  return norm;
}

function getGpsTrackingUrl(plate) {
  return `${GPS_PROXY_ORIGIN}${GPS_PROXY_PATH}/tracking?plate=${encodeURIComponent(plate)}`;
}

function normalizePlate(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function cleanCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function getStatusClass(status) {
  return String(status || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toRad(value) {
  return value * Math.PI / 180;
}

function toDeg(value) {
  return value * 180 / Math.PI;
}

function asCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidCoordinate(latitude, longitude) {
  return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function distanceKm(a, b) {
  const radiusKm = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return radiusKm * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}

function bearingDegrees(a, b) {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDelta(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function formatDistance(km) {
  if (!Number.isFinite(km)) return "-";
  return `${Math.max(0, Math.round(km)).toLocaleString()} km`;
}

function formatDurationFromHours(hours) {
  if (!Number.isFinite(hours)) return "-";
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  if (wholeHours <= 0) return `${Math.max(1, minutes)} min`;
  return `${wholeHours}h ${minutes.toString().padStart(2, "0")}m`;
}

function formatCoordinatePair(latitude, longitude) {
  if (!isValidCoordinate(latitude, longitude)) return "Coordinates pending";
  const latSuffix = latitude >= 0 ? "N" : "S";
  const lngSuffix = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(4)} ${latSuffix}, ${Math.abs(longitude).toFixed(4)} ${lngSuffix}`;
}

// --- Route-corridor projection: this is the single source of truth for
// "where on the route is this point" and "which country is that". It
// replaces the old combo of nearest-of-9-points + hardcoded longitude
// cutoff, which is what caused the Ethiopia/Djibouti flip-flopping. ---

function projectPointOnSegment(point, segmentStart, segmentEnd) {
  const latRef = toRad((segmentStart.latitude + segmentEnd.latitude) / 2);
  const lonScale = Math.cos(latRef) || 1;

  const ax = segmentStart.longitude * lonScale;
  const ay = segmentStart.latitude;
  const bx = segmentEnd.longitude * lonScale;
  const by = segmentEnd.latitude;
  const px = point.longitude * lonScale;
  const py = point.latitude;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const rawT = lengthSquared > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0;
  const t = Math.min(1, Math.max(0, rawT));

  const projection = {
    latitude: segmentStart.latitude + t * (segmentEnd.latitude - segmentStart.latitude),
    longitude: segmentStart.longitude + t * (segmentEnd.longitude - segmentStart.longitude)
  };

  return { t, distanceKm: distanceKm(point, projection), projection };
}

function resolveCorridorLocation(point) {
  let best = null;

  for (let index = 0; index < ROUTE_WAYPOINTS.length - 1; index += 1) {
    const segmentStart = ROUTE_WAYPOINTS[index];
    const segmentEnd = ROUTE_WAYPOINTS[index + 1];
    const projection = projectPointOnSegment(point, segmentStart, segmentEnd);

    if (!best || projection.distanceKm < best.distanceKm) {
      best = { ...projection, segmentStart, segmentEnd };
    }
  }

  if (!best) {
    return { country: ROUTE_WAYPOINTS[0].country, nearestPlace: ROUTE_WAYPOINTS[0] };
  }

  const sameCountry = best.segmentStart.country === best.segmentEnd.country;
  const country = sameCountry
    ? best.segmentStart.country
    : best.t < 0.5
      ? best.segmentStart.country
      : best.segmentEnd.country;
  const nearestPlace = best.t < 0.5 ? best.segmentStart : best.segmentEnd;

  return { country, nearestPlace };
}

function getGoogleMapsUrl(point) {
  const latitude = asCoordinate(point?.latitude);
  const longitude = asCoordinate(point?.longitude);
  if (!isValidCoordinate(latitude, longitude)) return "";
  return `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function getRouteStopsWithDistance(route) {
  let routeKm = 0;
  return route.map((stop, index) => {
    if (index > 0) routeKm += distanceKm(route[index - 1], stop);
    return { ...stop, routeKm };
  });
}

function getRouteDistanceAtPoint(point, route) {
  let best = null;
  let routeKmBeforeSegment = 0;

  for (let index = 0; index < route.length - 1; index += 1) {
    const segmentStart = route[index];
    const segmentEnd = route[index + 1];
    const segmentKm = distanceKm(segmentStart, segmentEnd);
    const projection = projectPointOnSegment(point, segmentStart, segmentEnd);
    const routeKm = routeKmBeforeSegment + segmentKm * projection.t;

    if (!best || projection.distanceKm < best.distanceKm) {
      best = { ...projection, routeKm, index };
    }

    routeKmBeforeSegment += segmentKm;
  }

  return best;
}

function getNextRouteStop(point, isReturnTrip) {
  const route = isReturnTrip ? [...ROUTE_WAYPOINTS].reverse() : ROUTE_WAYPOINTS;
  const routeStops = getRouteStopsWithDistance(route);
  const current = getRouteDistanceAtPoint(point, route);
  if (!current) return null;

  const nextPlace = routeStops.find((stop, index) => index > 0 && stop.routeKm > current.routeKm + 0.2) || routeStops[routeStops.length - 1];
  const nextDistanceKm = Math.max(0, nextPlace.routeKm - current.routeKm);

  return {
    name: nextPlace.name,
    country: nextPlace.country,
    distance: formatDistance(nextDistanceKm),
    time: formatDurationFromHours(nextDistanceKm / ROUTE_SPEED_KMH)
  };
}

function getPlaceImageUrls(placeName, point) {
  return [];
}

function getGpsPlaceLabel(rawLabel, nearestPlace) {
  const fallback = `Near ${nearestPlace.name}`;
  const text = cleanCell(rawLabel || "");
  if (!text) return fallback;

  const locationMatch = text.match(/Location\s+(.+?)\s+(?:Timestamp|Company|Driver|Driver Phone|Device Phone|Device IMEI|Coordinates|Follow|History|Best View|Stoppages|$)/i);
  const candidate = cleanCell(locationMatch ? locationMatch[1] : text)
    .replace(/^Location\s*/i, "")
    .replace(/\b(?:moving|stopped|idle|online|offline|ignition off|engine off)\b/gi, "")
    .trim();

  if (!candidate || /live tracking|vehicle|speed|ignition/i.test(candidate)) return fallback;
  return candidate.length > 92 ? `${candidate.slice(0, 89).trim()}...` : candidate;
}

function getLatestRowDate(row) {
  const dateText = cleanCell(row?.arrival_date || "");
  if (!dateText) return null;

  const timeText = cleanCell(row?.batch_time || "00:00").slice(0, 5);
  const date = new Date(`${dateText}T${timeText || "00:00"}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLatestRowAgeDays(row) {
  const date = getLatestRowDate(row);
  if (!date) return null;
  return Math.max(0, (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function inferStationaryDirection(latestRow) {
  const ageDays = getLatestRowAgeDays(latestRow);
  if (ageDays === null) {
    return {
      isReturnTrip: false,
      confidence: "Stationary estimate"
    };
  }

  return {
    isReturnTrip: ageDays <= 3,
    confidence: "Stationary estimate"
  };
}

function compactGpsText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function gpsTextMatchesPlate(text, plate) {
  const source = String(text || "");
  const compactSource = compactGpsText(source);
  const compactPlate = compactGpsText(plate);
  return Boolean(
    plate &&
    (source.includes(plate) || (compactPlate && compactSource.includes(compactPlate)))
  );
}

function parseGpsCoordinateText(text) {
  const source = String(text || "").replace(/\s+/g, " ");
  const explicitCopyMatch = source.match(/handleCopyCoords\([^0-9-]*(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/i);
  const match = explicitCopyMatch || source.match(/(?:Coordinates\s*)?(-?\d{1,2}\.\d{3,})\s*(?:\u00b0)?\s*([NS])?[,;\s]+(-?\d{1,3}\.\d{3,})\s*(?:\u00b0)?\s*([EW])?/i);
  if (!match) return null;

  let latitude = asCoordinate(match[1]);
  let longitude = asCoordinate(explicitCopyMatch ? match[2] : match[3]);
  if (!explicitCopyMatch && match[2] && match[2].toUpperCase() === "S") latitude = -Math.abs(latitude);
  if (!explicitCopyMatch && match[4] && match[4].toUpperCase() === "W") longitude = -Math.abs(longitude);

  return isValidCoordinate(latitude, longitude) ? { latitude, longitude } : null;
}

function getElementSearchText(element) {
  if (!element) return "";
  const attributes = ["onclick", "title", "aria-label", "alt", "data-plate", "data-license", "data-registration", "class", "src", "style"];
  const ownText = attributes.map((name) => element.getAttribute?.(name)).filter(Boolean).join(" ");
  const childText = Array.from(element.querySelectorAll?.("*") || [])
    .slice(0, 80)
    .map((node) => attributes.map((name) => node.getAttribute?.(name)).filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" ");

  return `${element.innerText || ""} ${element.textContent || ""} ${ownText} ${childText}`;
}

function extractGpsLocationLabelFromText(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => cleanCell(line))
    .filter(Boolean);
  const labelWords = /^(speed|ignition|location|timestamp|company|driver|driver phone|device phone|device imei|coordinates|follow|history|best view|stoppages)$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/location/i.test(line)) continue;

    const sameLine = cleanCell(line.replace(/^.*?\bLocation\b/i, ""));
    if (sameLine && !labelWords.test(sameLine)) return sameLine.slice(0, 220);

    const next = lines.slice(index + 1).find((candidate) => !labelWords.test(candidate));
    if (next) return next.slice(0, 220);
  }

  const compactText = cleanCell(String(text || "").replace(/\s+/g, " "));
  const match = compactText.match(/Location\s+(.+?)\s+(?:Timestamp|Company|Driver|Driver Phone|Device Phone|Device IMEI|Coordinates|Follow|History|Best View|Stoppages|$)/i);
  return match ? match[1].trim().slice(0, 220) : "";
}

function parseTileUrl(src) {
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
}

function findReferenceTile(doc) {
  if (!doc) return null;
  const containers = Array.from(doc.querySelectorAll(".leaflet-tile-pane .leaflet-tile-container"))
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
}

function markerLatLngFromTile(markerEl, referenceTile) {
  if (!markerEl || !referenceTile) return null;
  const markerRect = markerEl.getBoundingClientRect();
  if (!markerRect.width || !markerRect.height) return null;

  const anchorX = markerRect.left + markerRect.width / 2;
  const anchorY = markerRect.top + markerRect.height / 2;
  const worldPxPerScreenX = 256 / referenceTile.rect.width;
  const worldPxPerScreenY = 256 / referenceTile.rect.height;

  const worldX = referenceTile.tileX * 256 + (anchorX - referenceTile.rect.left) * worldPxPerScreenX;
  const worldY = referenceTile.tileY * 256 + (anchorY - referenceTile.rect.top) * worldPxPerScreenY;

  const n = 2 ** referenceTile.zoom;
  const longitude = (worldX / (256 * n)) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / (256 * n))));
  const latitude = (latRad * 180) / Math.PI;

  return isValidCoordinate(latitude, longitude) ? { latitude, longitude } : null;
}

function markerHeadingFromSvg(markerEl) {
  const svg = markerEl?.querySelector("svg");
  if (!svg) return null;
  const source = `${svg.getAttribute("style") || ""} ${svg.getAttribute("transform") || ""}`;
  const match = source.match(/rotate\((-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const deg = parseFloat(match[1]);
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null;
}

function getLayerText(layer) {
  const parts = [];
  try { if (layer.options?.title) parts.push(layer.options.title); } catch {}
  try { if (layer.options?.alt) parts.push(layer.options.alt); } catch {}
  try { if (layer.options?.plate) parts.push(layer.options.plate); } catch {}
  try { if (layer.getTooltip?.()?.getContent) parts.push(String(layer.getTooltip().getContent())); } catch {}
  try { if (layer.getPopup?.()?.getContent) parts.push(String(layer.getPopup().getContent())); } catch {}
  try { if (layer._icon) parts.push(getElementSearchText(layer._icon)); } catch {}
  return parts.join(" ");
}

function findLeafletLocation(doc, targetPlate) {
  const win = doc?.defaultView;
  if (!win) return null;

  const maps = [];
  Object.keys(win).some((key) => {
    try {
      const value = win[key];
      if (value && typeof value.eachLayer === "function" && typeof value.latLngToContainerPoint === "function") {
        maps.push(value);
      }
    } catch {}
    return maps.length > 4;
  });

  for (const map of maps) {
    const candidates = [];
    try {
      map.eachLayer((layer) => {
        if (!layer || typeof layer.getLatLng !== "function") return;
        const latLng = layer.getLatLng();
        const latitude = asCoordinate(latLng?.lat);
        const longitude = asCoordinate(latLng?.lng);
        if (!isValidCoordinate(latitude, longitude)) return;

        const layerText = getLayerText(layer);
        const matchesPlate = gpsTextMatchesPlate(layerText, targetPlate);
        const popupOpen = Boolean(
          (layer.isPopupOpen && layer.isPopupOpen()) ||
          (layer.getPopup?.()?.isOpen && layer.getPopup().isOpen())
        );
        const visibleIcon = Boolean(layer._icon);
        const heading = asCoordinate(layer.options?.rotationAngle ?? layer.options?.angle ?? layer.options?.heading ?? layer.options?.rotation);

        candidates.push({
          latitude,
          longitude,
          heading,
          label: extractGpsLocationLabelFromText(layerText),
          score: (matchesPlate ? 100 : 0) + (popupOpen ? 50 : 0) + (visibleIcon ? 8 : 0) + (layerText ? 5 : 0)
        });
      });
    } catch {}

    const strongCandidates = candidates.filter((candidate) => candidate.score >= 50);
    if (strongCandidates.length || candidates.length === 1) {
      const pool = strongCandidates.length ? strongCandidates : candidates;
      pool.sort((a, b) => b.score - a.score);
      return pool[0];
    }
  }

  return null;
}

function findVehicleMarkerElement(doc, targetPlate) {
  if (!doc || !targetPlate) return null;
  const markers = Array.from(doc.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon"));
  return markers
    .map((el) => ({ el, text: getElementSearchText(el) }))
    .find(({ text }) => gpsTextMatchesPlate(text, targetPlate))?.el || null;
}

function scrapeGpsDocument(doc, targetPlate) {
  if (!doc?.body) return null;

  const markerEl = findVehicleMarkerElement(doc, targetPlate);

  if (markerEl) {
    const referenceTile = findReferenceTile(doc);
    const fromTile = referenceTile ? markerLatLngFromTile(markerEl, referenceTile) : null;
    if (fromTile) {
      return { ...fromTile, heading: markerHeadingFromSvg(markerEl), label: "" };
    }
  }

  const leafletLocation = findLeafletLocation(doc, targetPlate);
  if (leafletLocation) return leafletLocation;

  const selectors = [
    ".leaflet-popup-content",
    ".custom-vehicle-popup",
    ".leaflet-popup",
    "[class*='vehicle']",
    "[class*='detail']",
    "body"
  ].join(", ");

  const candidates = Array.from(doc.querySelectorAll(selectors))
    .filter((element) => {
      const text = getElementSearchText(element);
      return gpsTextMatchesPlate(text, targetPlate) || /Coordinates/i.test(text);
    })
    .sort((a, b) => {
      const aText = getElementSearchText(a);
      const bText = getElementSearchText(b);
      const aScore = (a.matches(".leaflet-popup-content") ? 100 : 0) + (gpsTextMatchesPlate(aText, targetPlate) ? 50 : 0);
      const bScore = (b.matches(".leaflet-popup-content") ? 100 : 0) + (gpsTextMatchesPlate(bText, targetPlate) ? 50 : 0);
      return bScore - aScore;
    });

  for (const element of candidates) {
    const text = getElementSearchText(element);
    const coordinates = parseGpsCoordinateText(text);
    if (coordinates) {
      return {
        ...coordinates,
        label: extractGpsLocationLabelFromText(element.innerText || element.textContent || text)
      };
    }
  }

  return null;
}

function buildRouteInsight(location, previousLocation, latestRow) {
  const totalKm = distanceKm(ROUTE_NODES.start, ROUTE_NODES.destination);
  const base = {
    hasLiveLocation: false,
    start: ROUTE_NODES.start,
    destination: ROUTE_NODES.destination,
    directionSource: "Waiting for live GPS",
    countryLabel: "GPS pending",
    googleMapsUrl: "",
    distanceLeft: "-",
    timeLeft: "-",
    progress: 0,
    placeLabel: "Waiting for GPS fix",
    placeDetail: "Coordinates pending",
    latitude: null,
    longitude: null,
    nextPlaceName: "-",
    nextPlaceCountry: "",
    nextPlaceDistance: "-",
    nextPlaceTime: "-",
    nearestPlaceName: ROUTE_WAYPOINTS[0].name,
    imageUrls: getPlaceImageUrls("Bole Addis Ababa", ROUTE_NODES.start)
  };

  const latitude = asCoordinate(location?.latitude);
  const longitude = asCoordinate(location?.longitude);
  if (!isValidCoordinate(latitude, longitude)) return base;

  const point = { latitude, longitude };
  const forwardBearing = bearingDegrees(ROUTE_NODES.start, ROUTE_NODES.destination);
  const reverseBearing = (forwardBearing + 180) % 360;
  let heading = asCoordinate(location?.heading);

  const prevLat = asCoordinate(previousLocation?.latitude);
  const prevLng = asCoordinate(previousLocation?.longitude);
  let directionSource = "Truck arrow heading";
  if (heading === null && isValidCoordinate(prevLat, prevLng) && distanceKm({ latitude: prevLat, longitude: prevLng }, point) >= 0.05) {
    heading = bearingDegrees({ latitude: prevLat, longitude: prevLng }, point);
    directionSource = "Recent GPS movement";
  }

  const stationaryInference = inferStationaryDirection(latestRow);
  const isReturnTrip = heading !== null
    ? angleDelta(heading, reverseBearing) < angleDelta(heading, forwardBearing)
    : stationaryInference.isReturnTrip;
  if (heading === null) directionSource = "Stationary row estimate";

  const routeStart = isReturnTrip ? ROUTE_NODES.destination : ROUTE_NODES.start;
  const routeDestination = isReturnTrip ? ROUTE_NODES.start : ROUTE_NODES.destination;
  const remainingKm = distanceKm(point, routeDestination);
  const completedPercent = Math.min(100, Math.max(0, (1 - remainingKm / totalKm) * 100));

  const { country: countryLabel, nearestPlace } = resolveCorridorLocation(point);
  const placeLabel = getGpsPlaceLabel(location?.label, nearestPlace);
  const nextStop = getNextRouteStop(point, isReturnTrip);

  return {
    hasLiveLocation: true,
    start: routeStart,
    destination: routeDestination,
    directionSource,
    countryLabel,
    googleMapsUrl: getGoogleMapsUrl(point),
    distanceLeft: formatDistance(remainingKm),
    timeLeft: formatDurationFromHours(remainingKm / ROUTE_SPEED_KMH),
    progress: completedPercent,
    placeLabel,
    placeDetail: formatCoordinatePair(latitude, longitude),
    latitude,
    longitude,
    nextPlaceName: nextStop?.name || routeDestination.shortName,
    nextPlaceCountry: nextStop?.country || "",
    nextPlaceDistance: nextStop?.distance || formatDistance(remainingKm),
    nextPlaceTime: nextStop?.time || formatDurationFromHours(remainingKm / ROUTE_SPEED_KMH),
    nearestPlaceName: nearestPlace.name,
    imageUrls: getPlaceImageUrls(placeLabel, point)
  };
}

function uniqueImageUrls(urls) {
  return Array.from(new Set(urls.filter(Boolean)));
}

// --- Coordinate-based image lookup. This replaces the old name-text
// search, which matched on noisy scraped labels and frequently returned
// images for the wrong place. Geosearch against the real lat/lng is the
// reliable signal; clean waypoint names are only a fallback. ---

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function fetchWikipediaThumbnails(pageIds) {
  if (!pageIds.length) return [];
  const params = new URLSearchParams({
    action: "query",
    pageids: pageIds.join("|"),
    prop: "pageimages|categories",
    piprop: "thumbnail",
    pithumbsize: "960",
    format: "json",
    origin: "*"
  });
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  const pages = data?.query?.pages || {};
  return pageIds
    .map((id) => {
      const page = pages[id];
      const url = page?.thumbnail?.source || "";
      const title = page?.title || "";
      const categories = page?.categories || [];
      if (url && isActualPhoto(url) && !shouldExclude(url, title, categories)) {
        return url;
      }
      return null;
    })
    .filter(Boolean);
}

async function geosearchWikipediaImages(latitude, longitude, radiusMeters) {
  const params = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${latitude}|${longitude}`,
    gsradius: String(radiusMeters),
    gslimit: "6",
    format: "json",
    origin: "*"
  });
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  const results = data?.query?.geosearch || [];
  if (!results.length) return [];
  return fetchWikipediaThumbnails(results.map((page) => page.pageid));
}

async function geosearchCommonsImages(latitude, longitude, radiusMeters) {
  const searchParams = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${latitude}|${longitude}`,
    gsradius: String(radiusMeters),
    gsnamespace: "6",
    gslimit: "6",
    format: "json",
    origin: "*"
  });
  const searchData = await fetchJson(`https://commons.wikimedia.org/w/api.php?${searchParams.toString()}`);
  const results = searchData?.query?.geosearch || [];
  if (!results.length) return [];

  const imageParams = new URLSearchParams({
    action: "query",
    titles: results.map((page) => page.title).join("|"),
    prop: "imageinfo|categories",
    iiprop: "url",
    iiurlwidth: "960",
    format: "json",
    origin: "*"
  });
  const imageData = await fetchJson(`https://commons.wikimedia.org/w/api.php?${imageParams.toString()}`);
  const pages = imageData?.query?.pages ? Object.values(imageData.query.pages) : [];
  return pages
    .filter((page) => {
      const info = page?.imageinfo?.[0];
      const url = info?.thumburl || info?.url || "";
      const title = page.title || "";
      const categories = page.categories || [];
      return isActualPhoto(url) && !shouldExclude(url, title, categories);
    })
    .map((page) => page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url)
    .filter(Boolean);
}

function isActualPhoto(url) {
  if (!url) return false;
  const lowercase = url.toLowerCase();
  if (lowercase.includes(".svg")) return false;
  const forbidden = ["flag", "logo", "icon", "symbol", "emblem", "shield", "map_of", "map-of"];
  return !forbidden.some(word => lowercase.includes(word));
}

function shouldExclude(url, title, categories = []) {
  const categoriesText = categories.map(c => c.title || "").join(" ");
  const textToTest = `${url} ${title || ""} ${categoriesText}`.toLowerCase();
  
  const personKeywords = [
    "people", "person", "portrait", "face", "crowd", "human", "selfie",
    "man_", "_man", "woman", "women", "boy", "girl", "child", "infant",
    "baby", "lady", "gentleman", "soldier", "police", "president", "minister",
    "protest", "parade", "audience", "tourist", "visitor", "group_of", "biography",
    "births", "deaths", "politician", "leader", "member", "patrol", "navy", "army"
  ];
  
  const spaceKeywords = [
    "space", "galaxy", "nebula", "satellite", "orbit", "cosmos", "universe",
    "starry", "constellation", "astronomy", "hubble", "telescope", "planet",
    "crater", "milky_way", "spacecraft", "spacesuit", "iss_", " shuttle",
    "nasa", "esa", "jaxa", "cosmonaut", "astronaut", "meteor", "asteroid",
    "comet", "outer_space", "earth_from_space", "apollo", "spitzer", "kepler"
  ];
  
  const hasPerson = personKeywords.some(kw => textToTest.includes(kw));
  const hasSpace = spaceKeywords.some(kw => textToTest.includes(kw));
  
  return hasPerson || hasSpace;
}

async function searchWikipediaImages(query) {
  if (!query) return [];
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "8",
    prop: "pageimages|categories",
    piprop: "thumbnail",
    pithumbsize: "960",
    format: "json",
    origin: "*"
  });
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?${params.toString()}`);
  const pages = data?.query?.pages || {};
  return Object.values(pages)
    .filter((page) => {
      const url = page?.thumbnail?.source || "";
      const title = page?.title || "";
      const categories = page?.categories || [];
      return url && isActualPhoto(url) && !shouldExclude(url, title, categories);
    })
    .map((page) => page?.thumbnail?.source)
    .filter(Boolean);
}

async function searchCommonsImages(query) {
  if (!query) return [];
  const searchParams = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "8",
    format: "json",
    origin: "*"
  });
  const searchData = await fetchJson(`https://commons.wikimedia.org/w/api.php?${searchParams.toString()}`);
  const results = searchData?.query?.pages || {};
  const titles = Object.values(results).map((page) => page.title);
  if (!titles.length) return [];

  const imageParams = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "imageinfo|categories",
    iiprop: "url",
    iiurlwidth: "960",
    format: "json",
    origin: "*"
  });
  const imageData = await fetchJson(`https://commons.wikimedia.org/w/api.php?${imageParams.toString()}`);
  const pages = imageData?.query?.pages ? Object.values(imageData.query.pages) : [];
  return pages
    .filter((page) => {
      const info = page?.imageinfo?.[0];
      const url = info?.thumburl || info?.url || "";
      const title = page.title || "";
      const categories = page.categories || [];
      return isActualPhoto(url) && !shouldExclude(url, title, categories);
    })
    .map((page) => page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url)
    .filter(Boolean);
}

const imageCache = new Map();

async function fetchNearbyPlaceImages(latitude, longitude, fallbackPlaceName) {
  const cacheKey = fallbackPlaceName || `${latitude?.toFixed(3)},${longitude?.toFixed(3)}`;
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  const hasPoint = isValidCoordinate(latitude, longitude);
  let geoImages = [];

  if (hasPoint) {
    const [wikiResult, commonsResult] = await Promise.allSettled([
      geosearchWikipediaImages(latitude, longitude, 3000),
      geosearchCommonsImages(latitude, longitude, 3000)
    ]);
    geoImages = uniqueImageUrls([
      ...(wikiResult.status === "fulfilled" ? wikiResult.value : []),
      ...(commonsResult.status === "fulfilled" ? commonsResult.value : [])
    ]).filter(isActualPhoto);
  }

  let textImages = [];
  if (fallbackPlaceName) {
    const cleanQuery = fallbackPlaceName
      .replace(/^Near\s+/i, "")
      .replace(/\bBorder\b/gi, "")
      .replace(/\bPort\b/gi, "")
      .trim();

    const [wikiTextResult, commonsTextResult] = await Promise.allSettled([
      searchWikipediaImages(cleanQuery),
      searchCommonsImages(cleanQuery)
    ]);

    textImages = uniqueImageUrls([
      ...(wikiTextResult.status === "fulfilled" ? wikiTextResult.value : []),
      ...(commonsTextResult.status === "fulfilled" ? commonsTextResult.value : [])
    ]);
  }

  const combined = uniqueImageUrls([...geoImages, ...textImages]).slice(0, 3);
  imageCache.set(cacheKey, combined);
  return combined;
}

function RouteGallery({ imageUrls, alt, latitude, longitude, fallbackPlaceName }) {
  const [inlineIndex, setInlineIndex] = useState(0);
  const [remoteImages, setRemoteImages] = useState([]);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const imageSources = uniqueImageUrls([imageUrls[0], ...remoteImages, ...imageUrls.slice(1)]).slice(0, 3);
  const imageKey = `${latitude}|${longitude}|${fallbackPlaceName}|${imageSources.join("|")}`;

  useEffect(() => {
    setInlineIndex(0);
  }, [imageKey]);

  useEffect(() => {
    let ignore = false;
    setRemoteImages([]);

    fetchNearbyPlaceImages(latitude, longitude, fallbackPlaceName)
      .then((images) => {
        if (!ignore) setRemoteImages(images);
      })
      .catch(() => {
        if (!ignore) setRemoteImages([]);
      });

    return () => {
      ignore = true;
    };
  }, [latitude, longitude, fallbackPlaceName]);

  const openLightbox = (index) => setLightboxIndex(index);
  const closeLightbox = () => setLightboxIndex(null);
  const moveLightbox = (step) => {
    setLightboxIndex((index) => {
      if (index === null || !imageSources.length) return index;
      return (index + step + imageSources.length) % imageSources.length;
    });
  };
  const inlineSrc = imageSources[inlineIndex] || "/errorimg.png";
  const lightboxSrc = lightboxIndex === null ? "" : imageSources[lightboxIndex];

  return (
    <>
      <button type="button" className="route-gallery-main" onClick={() => openLightbox(inlineIndex)} aria-label={`Open images for ${alt}`}>
        <img
          src={inlineSrc}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.target.onerror = null;
            e.target.src = "/errorimg.png";
          }}
        />
      </button>

      <div className="route-gallery-dots" aria-label="Nearby image pages">
        {imageSources.slice(0, 3).map((src, index) => (
          <button
            type="button"
            key={src}
            className={index === inlineIndex ? "active" : ""}
            onClick={() => setInlineIndex(index)}
            aria-label={`Show nearby image ${index + 1}`}
          />
        ))}
      </div>

      {lightboxIndex !== null ? (
        <div className="route-gallery-lightbox" onClick={closeLightbox} role="dialog" aria-modal="true" aria-label={`Images for ${alt}`}>
          <div className="route-gallery-lightbox-inner" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="route-gallery-close" onClick={closeLightbox} aria-label="Close image viewer">x</button>
            <button type="button" className="route-gallery-nav previous" onClick={() => moveLightbox(-1)} aria-label="Previous image">&lt;</button>
            <img 
              src={lightboxSrc} 
              alt={alt} 
              referrerPolicy="no-referrer" 
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = "/errorimg.png";
              }}
            />
            <button type="button" className="route-gallery-nav next" onClick={() => moveLightbox(1)} aria-label="Next image">&gt;</button>
            <div className="route-gallery-count">
              {lightboxIndex + 1} / {imageSources.length}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function GpsTrackingPanel({ isOpen, onClose, selectedPlate, plateLabel, driver, latestRow }) {
  const [gpsStatus, setGpsStatus] = useState("Initializing...");
  const [gpsFrameError, setGpsFrameError] = useState("");
  const [gpsReloadKey, setGpsReloadKey] = useState(0);
  const [gpsLocation, setGpsLocation] = useState(null);
  const [isRoutePanelExpanded, setIsRoutePanelExpanded] = useState(false);
  const previousGpsLocationRef = useRef(null);

  const gpsPlate = getMapPlateFormat(selectedPlate);
  const gpsFrameUrl = getGpsTrackingUrl(gpsPlate);
  const gpsStatusClass = getStatusClass(gpsStatus);
  const routeInsight = buildRouteInsight(gpsLocation, previousGpsLocationRef.current, latestRow);
  const driverName = driver?.name || "Driver";

  useEffect(() => {
    if (!isOpen) {
      setGpsStatus("Closed");
      return;
    }

    setGpsFrameError("");
    setGpsStatus("Connecting...");
    setGpsLocation(null);
    previousGpsLocationRef.current = null;
    setIsRoutePanelExpanded(false);
  }, [gpsFrameUrl, isOpen]);

  const retryGpsPanel = () => {
    setGpsFrameError("");
    setGpsStatus("Connecting...");
    setGpsLocation(null);
    previousGpsLocationRef.current = null;
    setGpsReloadKey((key) => key + 1);
  };

  const handleGpsFrameLoad = (event) => {
    try {
      const iframe = event.currentTarget;
      const doc = iframe.contentDocument;
      const title = doc?.title || "";
      const isTruckTrackerFallback = title.includes("Truck Tracker") || Boolean(doc?.querySelector(".brand-logo"));

      if (isTruckTrackerFallback) {
        setGpsFrameError("GPS proxy is not running. Start the backend server, then try Location again.");
        setGpsStatus("Proxy unavailable");
      }
    } catch {
      // Cross-origin access can fail before the proxy rewrites the page.
    }
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleMessage = (event) => {
      const allowedOrigin = new URL(gpsFrameUrl, window.location.href).origin;
      if (event.origin !== window.location.origin && event.origin !== allowedOrigin) return;

      if (event.data?.type === "GPS_STATUS") {
        setGpsStatus(event.data.status);
        if (event.data.status !== "Proxy unavailable") setGpsFrameError("");
      }

      if (event.data?.type === "GPS_LOCATION") {
        const latitude = asCoordinate(event.data.latitude);
        const longitude = asCoordinate(event.data.longitude);
        if (isValidCoordinate(latitude, longitude)) {
          setGpsLocation((current) => {
            previousGpsLocationRef.current = current;
            return {
              latitude,
              longitude,
              heading: asCoordinate(event.data.heading),
              label: cleanCell(event.data.label || ""),
              receivedAt: Date.now()
            };
          });
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [gpsFrameUrl, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const scrapeFrame = () => {
      try {
        const iframe = document.getElementById("gps-iframe");
        const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
        const scrapedLocation = scrapeGpsDocument(doc, gpsPlate);
        if (!scrapedLocation) return;

        setGpsLocation((current) => {
          if (
            current &&
            current.latitude === scrapedLocation.latitude &&
            current.longitude === scrapedLocation.longitude &&
            cleanCell(current.label) === cleanCell(scrapedLocation.label)
          ) {
            return current;
          }

          previousGpsLocationRef.current = current;
          return {
            latitude: scrapedLocation.latitude,
            longitude: scrapedLocation.longitude,
            heading: asCoordinate(scrapedLocation.heading),
            label: cleanCell(scrapedLocation.label || ""),
            receivedAt: Date.now()
          };
        });

        setGpsStatus("Live Tracking");
        setGpsFrameError("");
      } catch {
        // The iframe should be same-origin through the GPS proxy once it is ready.
      }
    };

    scrapeFrame();
    const scrapeInterval = setInterval(scrapeFrame, 1200);
    return () => clearInterval(scrapeInterval);
  }, [gpsFrameUrl, gpsPlate, gpsReloadKey, isOpen]);

  useEffect(() => {
    if (!isOpen || gpsFrameError || gpsStatus === "Live Tracking" || gpsStatus === "Vehicle not found") return undefined;

    const timeoutId = setTimeout(() => {
      setGpsStatus((status) => status === "Live Tracking" ? status : "Still searching");
    }, 30000);

    return () => clearTimeout(timeoutId);
  }, [gpsFrameError, gpsFrameUrl, gpsReloadKey, gpsStatus, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="gps-modal-overlay" onClick={onClose}>
      <div className="gps-modal-content" onClick={(event) => event.stopPropagation()}>
        <div className="gps-modal-header">
          <div className="gps-modal-title-group">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="location-icon-animated">
              <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <div className="gps-modal-title-details">
              <h3>Live GPS</h3>
              <span>{driverName} · {plateLabel || selectedPlate}</span>
            </div>
          </div>

          <div className="gps-modal-controls">
            <span className={`gps-status-badge status-${gpsStatusClass}`}>
              {gpsStatus}
            </span>
            <button type="button" className="gps-modal-close" onClick={onClose} title="Close tracking panel" aria-label="Close tracking panel">
              x
            </button>
          </div>
        </div>

        <div className="gps-modal-body">
          {gpsFrameError ? (
            <div className="gps-panel-message" role="alert">
              <strong>GPS panel could not open</strong>
              <p>{gpsFrameError}</p>
              <button type="button" onClick={retryGpsPanel}>Retry</button>
            </div>
          ) : null}

          <iframe
            key={`${gpsFrameUrl}-${gpsReloadKey}`}
            id="gps-iframe"
            src={gpsFrameUrl}
            title="GPS Live Tracking Portal"
            className="gps-iframe"
            onLoad={handleGpsFrameLoad}
            onError={() => {
              setGpsFrameError(
                process.env.NODE_ENV === "development"
                  ? "Could not reach the GPS proxy. Start the backend server on port 5000."
                  : "Could not reach the GPS proxy. Try again after redeploying."
              );
              setGpsStatus("Connection failed");
            }}
          />

          <aside
            className={`gps-route-sheet${isRoutePanelExpanded ? " expanded" : " compact"}`}
            aria-label="Route estimate"
          >
            <button
              type="button"
              className="route-sheet-summary"
              onClick={() => setIsRoutePanelExpanded((value) => !value)}
              aria-expanded={isRoutePanelExpanded}
              title={isRoutePanelExpanded ? "Collapse route details" : "Expand route details"}
            >
              <span className={`route-live-dot${routeInsight.hasLiveLocation ? " active" : ""}`} />
              <span className="route-summary-text">
                <strong>{routeInsight.placeLabel}</strong>
                <small>{routeInsight.placeDetail}</small>
              </span>
              <span className="route-summary-stat">
                <strong>{routeInsight.distanceLeft}</strong>
                <small>{routeInsight.timeLeft}</small>
              </span>
              <span className="route-panel-toggle-chevron">
                {isRoutePanelExpanded ? "v" : "^"}
              </span>
              <span className="route-summary-progress" aria-hidden="true">
                <span style={{ width: `${routeInsight.progress}%` }} />
              </span>
              
            </button>

            {isRoutePanelExpanded ? (
              <div className="route-sheet-detail">
                
                
           
             <div className="route-panel-image">
                  <RouteGallery
                    imageUrls={routeInsight.imageUrls}
                    alt={routeInsight.placeLabel}
                    latitude={routeInsight.latitude}
                    longitude={routeInsight.longitude}
                    fallbackPlaceName={routeInsight.nearestPlaceName}
                  />
                </div>
            
        

                <div className="route-progress">
                  <div
                    className="route-progress-bar"
                    style={{ width: `${routeInsight.progress}%` }}
                  />
                </div>

                <div className="route-stat-grid">
                  <div>
                    <span>Distance left</span>
                    <strong>{routeInsight.distanceLeft}</strong>
                  </div>
                  <div>
                    <span>Time left</span>
                    <strong>{routeInsight.timeLeft}</strong>
                  </div>
                </div>

                <div className="route-endpoint-strip">
                  <div>
                    <span>Start</span>
                    <strong>{routeInsight.start.shortName}</strong>
                    <small>{routeInsight.start.location}</small>
                  </div>
                  <div>
                    <span>Destination</span>
                    <strong>{routeInsight.destination.shortName}</strong>
                    <small>{routeInsight.destination.location}</small>
                  </div>
                </div>

                <div className="route-next-strip">
                  <div>
                    <span>Next route point</span>
                    <strong>{routeInsight.nextPlaceName}</strong>
                    <small>{routeInsight.nextPlaceCountry || routeInsight.countryLabel}</small>
                  </div>
                  <div>
                    <span>Until next route point</span>
                    <strong>{routeInsight.nextPlaceDistance}</strong>
                    <small>{routeInsight.nextPlaceTime}</small>
                  </div>
                </div>

                <a
                  className={`route-map-link${routeInsight.googleMapsUrl ? "" : " disabled"}`}
                  href={routeInsight.googleMapsUrl || undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-disabled={!routeInsight.googleMapsUrl}
                  onClick={(event) => {
                    if (!routeInsight.googleMapsUrl) event.preventDefault();
                  }}
                >
                  Open in Google Maps
                </a>
                

              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
