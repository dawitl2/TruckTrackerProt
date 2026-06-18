const https = require("https");

const GPS_HOST = "gps2.ztrackinsight.com";
const GPS_ORIGIN = `https://${GPS_HOST}`;
const PROXY_PREFIX = "/api/gps-proxy";
const GPS_USERNAME = "enkua";
const GPS_PASSWORD = "E3456789";

const config = {
  api: {
    bodyParser: false,
  },
};

function getTargetPath(req) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
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

function rewriteProxyUrl(value) {
  if (!value) return value;

  try {
    const url = new URL(value, GPS_ORIGIN);
    if (url.origin !== GPS_ORIGIN) return value;
    if (url.pathname.startsWith(PROXY_PREFIX)) return `${url.pathname}${url.search}${url.hash}`;
    return `${PROXY_PREFIX}${url.pathname}${url.search}${url.hash}`;
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

function rewriteBody(body) {
  return body
    .replace(/(["'`])https:\/\/gps2\.ztrackinsight\.com\/(?!api\/gps-proxy\/)/g, `$1${PROXY_PREFIX}/`)
    .replace(/(["'(=])\/(?!api\/gps-proxy\/)(assets|api|vts-tabicon|polyfills-legacy|tracking)(?=\/|[.?#"'`\s>)]|$)/g, `$1${PROXY_PREFIX}/$2`)
    .replace(/url\((["']?)\/(?!api\/gps-proxy\/)assets\//g, `url($1${PROXY_PREFIX}/assets/`);
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

        var match = Array.from(document.querySelectorAll("button, [role='button'], li, div, span"))
          .find(function(element) {
            return element.textContent && element.textContent.includes(targetPlate);
          });

        if (match) {
          match.click();
          window.__lastSelectedPlate = targetPlate;
          setTimeout(closeMapPanels, 700);
          setTimeout(closeMapPanels, 1800);
          notify("Live Tracking");
        } else {
          searchAttempts += 1;
          if (searchAttempts > 15) notify("Vehicle not found");
        }
      } else {
        closeMapPanels();
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
        let nextBody = rewriteBody(body);
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
