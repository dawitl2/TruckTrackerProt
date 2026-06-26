const https = require("https");

const GPS_HOST = "gps2.ztrackinsight.com";
const GPS_ORIGIN = `https://${GPS_HOST}`;
const PROXY_PREFIX = "/api/gps-proxy";
const PROXY_RESOURCE_PATH = `${PROXY_PREFIX}/resource`;
const GPS_USERNAME = "enkua";
const GPS_PASSWORD = "E3456789";

const config = {
  api: {
    bodyParser: false,
  },
};

function getTargetPath(req) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const queryPath = requestUrl.searchParams.get("gpsPath");
  if (queryPath) return queryPath;

  let pathname = requestUrl.pathname;

  if (pathname.startsWith(PROXY_PREFIX)) {
    pathname = pathname.slice(PROXY_PREFIX.length) || "/";
    while (pathname.startsWith(PROXY_PREFIX)) {
      pathname = pathname.slice(PROXY_PREFIX.length) || "/";
    }
  } else if (Array.isArray(req.query?.path)) {
    pathname = `/${req.query.path.join("/")}`;
  } else {
    pathname = "/";
  }

  return `${pathname}${requestUrl.search}`;
}

function getProxyResourceUrl(path) {
  return `${PROXY_RESOURCE_PATH}?gpsPath=${encodeURIComponent(path)}`;
}

function rewriteProxyUrl(value) {
  if (!value) return value;

  try {
    const url = new URL(value, GPS_ORIGIN);
    if (url.origin !== GPS_ORIGIN) return value;
    if (url.pathname.startsWith(PROXY_PREFIX)) return `${url.pathname}${url.search}${url.hash}`;
    return getProxyResourceUrl(`${url.pathname}${url.search}`);
  } catch {
    return value;
  }
}

function rewriteHeaders(headers) {
  const nextHeaders = { ...headers };

  delete nextHeaders["x-frame-options"];
  delete nextHeaders["content-security-policy"];
  delete nextHeaders["x-content-type-options"];
  delete nextHeaders["content-security-policy-report-only"];
  delete nextHeaders["content-encoding"];
  delete nextHeaders["content-length"];

  if (nextHeaders.location) {
    nextHeaders.location = rewriteProxyUrl(nextHeaders.location);
  }

  if (nextHeaders["set-cookie"]) {
    nextHeaders["set-cookie"] = nextHeaders["set-cookie"].map((cookie) =>
      cookie.replace(/Domain=[^;]+;?\s*/gi, "")
    );
  }

  return nextHeaders;
}

function rewriteHtmlOrCssBody(body) {
  return body
    .replace(/(["'`])https:\/\/gps2\.ztrackinsight\.com(\/[^"'`\s<>)\\]*)/g, (_match, quote, path) => {
      if (path.startsWith(PROXY_PREFIX)) return `${quote}${path}`;
      return `${quote}${getProxyResourceUrl(path)}`;
    })
    .replace(/(["'(=])\/(?!api\/gps-proxy\/)(assets|vts-tabicon|polyfills-legacy)([^"'`\s<>)\\]*)/g, (_match, prefix, pathStart, pathRest) =>
      `${prefix}${getProxyResourceUrl(`/${pathStart}${pathRest}`)}`
    )
    .replace(/(["'(=])\/(?!api\/gps-proxy\/)(api|tracking)(?=\/|[?#"'`\s>)]|$)([^"'`\s<>)\\]*)/g, (_match, prefix, pathStart, pathRest) =>
      `${prefix}${PROXY_PREFIX}/${pathStart}${pathRest}`
    )
    .replace(/url\((["']?)\/(?!api\/gps-proxy\/)assets\/([^)"']+)/g, (_match, quote, pathRest) =>
      `url(${quote}${getProxyResourceUrl(`/assets/${pathRest}`)}`
    );
}

function rewriteJavaScriptBody(body) {
  return body
    .replace(/import\((["'])\.\/([^"'`]+)\1\)/g, (_match, quote, path) =>
      `import(${quote}${getProxyResourceUrl(`/assets/${path}`)}${quote})`
    )
    .replace(/(["'])assets\/([^"'`]+)\1/g, (_match, quote, path) =>
      `${quote}${getProxyResourceUrl(`/assets/${path}`)}${quote}`
    )
    .replace(/(["'`])https:\/\/gps2\.ztrackinsight\.com\/assets\/([^"'`\s<>)\\]*)/g, (_match, quote, path) =>
      `${quote}${getProxyResourceUrl(`/assets/${path}`)}`
    );
}

function gpsAutomationScript() {
  return `
<script>
(function() {
  window.parent.postMessage({ type: "GPS_STATUS", status: "Connecting..." }, "*");

  var targetPlate = new URLSearchParams(window.location.search).get("plate");
  var searchAttempts = 0;

  function setNativeValue(element, value) {
    var valueSetter = Object.getOwnPropertyDescriptor(element, "value") && Object.getOwnPropertyDescriptor(element, "value").set;
    var prototype = Object.getPrototypeOf(element);
    var prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value") && Object.getOwnPropertyDescriptor(prototype, "value").set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function notify(status) {
    window.parent.postMessage({ type: "GPS_STATUS", status: status }, "*");
  }

  function toNumber(value) {
    var number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : null;
  }

  function isValidCoordinate(latitude, longitude) {
    return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  }

  function parseCoordinateText(text) {
    var source = String(text || "").replace(/\\s+/g, " ");
    var explicitCopyMatch = source.match(/handleCopyCoords\\([^0-9-]*(-?\\d{1,2}\\.\\d{3,})\\s*,\\s*(-?\\d{1,3}\\.\\d{3,})/i);
    var match = explicitCopyMatch || source.match(/(?:Coordinates\\s*)?(-?\\d{1,2}\\.\\d{3,})\\s*(?:\\u00b0)?\\s*([NS])?[,\\s]+(-?\\d{1,3}\\.\\d{3,})\\s*(?:\\u00b0)?\\s*([EW])?/i);
    if (!match) return null;

    var latitude = toNumber(match[1]);
    var longitude = toNumber(explicitCopyMatch ? match[2] : match[3]);
    if (!explicitCopyMatch && match[2] && match[2].toUpperCase() === "S") latitude = -Math.abs(latitude);
    if (!explicitCopyMatch && match[4] && match[4].toUpperCase() === "W") longitude = -Math.abs(longitude);

    return isValidCoordinate(latitude, longitude) ? { latitude: latitude, longitude: longitude } : null;
  }

  function parseHeadingText(text) {
    var match = String(text || "").match(/(?:heading|course|bearing|direction|angle)[^0-9]{0,16}(\\d{1,3}(?:\\.\\d+)?)/i);
    var heading = match ? toNumber(match[1]) : null;
    return heading !== null ? ((heading % 360) + 360) % 360 : null;
  }

  function getPopupLocationLabel(text) {
    var source = String(text || "").replace(/\\s+/g, " ");
    var match = source.match(/Location\\s+(.+?)\\s+(?:Timestamp|Company|Driver|Driver Phone|Device Phone|Device IMEI|Coordinates|Follow|History|Best View|Stoppages|$)/i);
    return match ? match[1].trim().slice(0, 220) : "";
  }

  function getElementSearchText(element) {
    if (!element) return "";
    var attributes = ["onclick", "title", "aria-label", "alt", "data-plate", "data-license", "data-registration", "class", "src", "style"];
    var ownText = attributes.map(function(name) {
      return element.getAttribute && element.getAttribute(name);
    }).filter(Boolean).join(" ");
    var childText = Array.from(element.querySelectorAll ? element.querySelectorAll("*") : [])
      .slice(0, 80)
      .map(function(node) {
        return attributes.map(function(name) {
          return node.getAttribute && node.getAttribute(name);
        }).filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(" ");

    return [element.innerText, element.textContent, ownText, childText].filter(Boolean).join(" ");
  }

  function getVehicleLabel() {
    if (!targetPlate) return "";
    var match = Array.from(document.querySelectorAll(".leaflet-popup-content, button, [role='button'], li, aside, [role='dialog'], [class*='vehicle'], [class*='detail']"))
      .find(function(element) {
        var text = getElementSearchText(element);
        return textMatchesTargetPlate(text) && text.length < 1400;
      });

    return match ? getElementSearchText(match).replace(/\\s+/g, " ").trim().slice(0, 180) : "";
  }

  function getLayerText(layer) {
    var parts = [];
    try { if (layer.options && layer.options.title) parts.push(layer.options.title); } catch (error) {}
    try { if (layer.options && layer.options.alt) parts.push(layer.options.alt); } catch (error) {}
    try { if (layer.getTooltip && layer.getTooltip() && layer.getTooltip().getContent) parts.push(String(layer.getTooltip().getContent())); } catch (error) {}
    try { if (layer.getPopup && layer.getPopup() && layer.getPopup().getContent) parts.push(String(layer.getPopup().getContent())); } catch (error) {}
    try { if (layer._icon) parts.push(getElementSearchText(layer._icon)); } catch (error) {}
    return parts.join(" ");
  }

  function findLeafletLocation() {
    var maps = [];
    Object.keys(window).some(function(key) {
      try {
        var value = window[key];
        if (value && typeof value.eachLayer === "function" && typeof value.latLngToContainerPoint === "function") {
          maps.push(value);
        }
      } catch (error) {}
      return maps.length > 4;
    });

    for (var i = 0; i < maps.length; i += 1) {
      var candidates = [];
      try {
        maps[i].eachLayer(function(layer) {
          if (!layer || typeof layer.getLatLng !== "function") return;
          var latLng = layer.getLatLng();
          var latitude = toNumber(latLng && latLng.lat);
          var longitude = toNumber(latLng && latLng.lng);
          if (isValidCoordinate(latitude, longitude)) {
            var layerText = getLayerText(layer);
            var matchesPlate = textMatchesTargetPlate(layerText);
            var popupOpen = Boolean((layer.isPopupOpen && layer.isPopupOpen()) || (layer.getPopup && layer.getPopup() && layer.getPopup().isOpen && layer.getPopup().isOpen()));
            candidates.push({
              latitude: latitude,
              longitude: longitude,
              heading: toNumber(layer.options && (layer.options.rotationAngle || layer.options.angle || layer.options.heading || layer.options.rotation)),
              score: (matchesPlate ? 100 : 0) + (popupOpen ? 50 : 0) + (layerText ? 5 : 0)
            });
          }
        });
      } catch (error) {}
      if (candidates.length) {
        candidates.sort(function(a, b) { return b.score - a.score; });
        return candidates[0];
      }
    }

    return null;
  }

  function publishLocation() {
    var popupElements = Array.from(document.querySelectorAll(".leaflet-popup-content, .custom-vehicle-popup, .leaflet-popup"));
    var popupText = popupElements
      .map(function(element) {
        return [
          element.innerText,
          element.textContent,
          Array.from(element.querySelectorAll("[onclick]")).map(function(node) { return node.getAttribute("onclick"); }).join(" ")
        ].filter(Boolean).join(" ");
      })
      .find(function(text) { return textMatchesTargetPlate(text) || /Coordinates/i.test(text); });
    var bodyText = [popupText, document.body && document.body.innerText, document.body && document.body.textContent].filter(Boolean).join(" ");
    var location = parseCoordinateText(bodyText) || findLeafletLocation();
    if (!location) return;

    var heading = location.heading !== null && location.heading !== undefined
      ? location.heading
      : parseHeadingText(bodyText);

    window.parent.postMessage({
      type: "GPS_LOCATION",
      latitude: location.latitude,
      longitude: location.longitude,
      heading: heading,
      label: getPopupLocationLabel(bodyText) || getVehicleLabel()
    }, "*");
    notify("GPS coordinates found");
  }

  function textMatchesTargetPlate(text) {
    function compact(value) {
      return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    }
    return Boolean(targetPlate && (String(text || "").includes(targetPlate) || compact(text).includes(compact(targetPlate))));
  }

  function clickLikeUser(element) {
    if (!element) return false;
    ["mouseover", "mousedown", "mouseup", "click"].forEach(function(type) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  function findTargetMapElement() {
    var mapSelectors = [
      ".leaflet-popup-content",
      ".leaflet-marker-icon",
      ".leaflet-tooltip",
      ".leaflet-marker-pane div",
      ".leaflet-pane div",
      ".leaflet-container span",
      ".leaflet-container button"
    ].join(", ");

    var match = Array.from(document.querySelectorAll(mapSelectors))
      .find(function(element) {
        var text = getElementSearchText(element);
        return textMatchesTargetPlate(text) && text.length < 500;
      });

    if (!match) return null;
    return match.closest(".leaflet-marker-icon, .leaflet-tooltip, .leaflet-popup-content, .leaflet-pane > div") || match;
  }

  function findTargetListElement() {
    return Array.from(document.querySelectorAll("button, [role='button'], li"))
      .find(function(element) {
        var text = getElementSearchText(element);
        var blocked = element.closest("[aria-label*='Notifications'], [class*='notification'], [class*='alert']");
        return !blocked && textMatchesTargetPlate(text) && text.length < 900;
      });
  }

  function clickTargetVehicle() {
    var targetElement = findTargetMapElement() || findTargetListElement();
    return clickLikeUser(targetElement);
  }

  function closeMapPanels() {
    var closeButtons = Array.from(document.querySelectorAll(
      "button[aria-label*='Close'], button[title*='Close'], button[aria-label*='close'], button[title*='close']"
    ));
    closeButtons.forEach(function(button) {
      var area = button.closest("[role='dialog'], [data-vaul-drawer], aside, section, div");
      var text = (area && area.textContent || "").toLowerCase();
      if (text.includes("alert") || text.includes("alarm") || text.includes("vehicle") || text.includes("notification")) {
        button.click();
      }
    });

    Array.from(document.querySelectorAll("[data-vaul-drawer], aside, [role='dialog']")).forEach(function(panel) {
      var text = (panel.textContent || "").toLowerCase();
      var isMapControl = panel.closest(".leaflet-container") || panel.querySelector(".leaflet-container");
      if (!isMapControl && (text.includes("alert") || text.includes("alarm") || text.includes("notification"))) {
        panel.style.display = "none";
      }
    });
  }

  setInterval(function() {
    try {
      var usernameInput = document.getElementById("username") || document.querySelector("input[name='username'], input[type='text']");
      var passwordInput = document.getElementById("password") || document.querySelector("input[name='password'], input[type='password']");
      var submitBtn = document.querySelector("button[type='submit']");

      if (usernameInput && passwordInput && submitBtn) {
        notify("Logging in...");
        setNativeValue(usernameInput, "${GPS_USERNAME}");
        usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
        usernameInput.dispatchEvent(new Event("change", { bubbles: true }));
        setNativeValue(passwordInput, "${GPS_PASSWORD}");
        passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
        passwordInput.dispatchEvent(new Event("change", { bubbles: true }));

        if (usernameInput.value && passwordInput.value) {
          notify("Authenticating...");
          submitBtn.click();
        }
        return;
      }

      if (!targetPlate) {
        notify("Missing plate");
        return;
      }

      publishLocation();

      var searchInput = Array.from(document.querySelectorAll("input")).find(function(input) {
        var label = ((input.placeholder || "") + " " + (input.getAttribute("aria-label") || "")).toLowerCase();
        return label.includes("search") || label.includes("vehicle") || label.includes("plate");
      });

      if (!searchInput) return;

      if (window.__lastSelectedPlate !== targetPlate) {
        notify("Locating vehicle...");
        setNativeValue(searchInput, targetPlate);
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));

        if (clickTargetVehicle()) {
          window.__lastSelectedPlate = targetPlate;
          setTimeout(clickTargetVehicle, 500);
          setTimeout(clickTargetVehicle, 1500);
          setTimeout(closeMapPanels, 700);
          setTimeout(closeMapPanels, 1800);
          setTimeout(publishLocation, 900);
          setTimeout(publishLocation, 2000);
          notify("Live Tracking");
        } else {
          searchAttempts += 1;
          if (searchAttempts > 15) notify("Vehicle not found");
        }
      } else {
        clickTargetVehicle();
        closeMapPanels();
        publishLocation();
        notify("Live Tracking");
      }
    } catch (error) {
      console.error("GPS automation failed", error);
      notify("Error");
    }
  }, 1000);
})();
</script>`;
}

function handler(req, res) {
  const targetPath = getTargetPath(req);
  const headers = {
    ...req.headers,
    host: GPS_HOST,
    origin: GPS_ORIGIN,
    referer: `${GPS_ORIGIN}/tracking`,
    "accept-encoding": "identity",
  };

  delete headers["sec-fetch-site"];
  delete headers["sec-fetch-mode"];
  delete headers["sec-fetch-dest"];

  const proxyReq = https.request(
    {
      hostname: GPS_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = rewriteHeaders(proxyRes.headers);
      const contentType = proxyRes.headers["content-type"] || "";
      const shouldTransform =
        contentType.includes("text/html") ||
        contentType.includes("text/css") ||
        contentType.includes("javascript");

      if (!shouldTransform) {
        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
        return;
      }

      let body = "";
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", (chunk) => {
        body += chunk;
      });
      proxyRes.on("end", () => {
        let nextBody = contentType.includes("javascript")
          ? rewriteJavaScriptBody(body)
          : rewriteHtmlOrCssBody(body);
        if (contentType.includes("text/html")) {
          nextBody = nextBody.replace(/<\/body>/i, `${gpsAutomationScript()}</body>`);
        }
        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        res.end(nextBody);
      });
    }
  );

  proxyReq.on("error", (error) => {
    console.error("GPS proxy error:", error);
    res.status(502).send("GPS proxy could not reach the tracking site.");
  });

  req.pipe(proxyReq);
}

module.exports = handler;
module.exports.config = config;
