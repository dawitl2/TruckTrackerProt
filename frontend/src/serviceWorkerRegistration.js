const isLocalhost = Boolean(
  window.location.hostname === "localhost" ||
    window.location.hostname === "[::1]" ||
    window.location.hostname.match(
      /^127(?:\.(?:\d{1,3})){3}$/
    )
);

export function register(config) {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`;

    if (isLocalhost) {
      checkValidServiceWorker(swUrl, config);
      navigator.serviceWorker.ready.then(() => {
        console.log("This web app is being served cache-first by a service worker.");
      });
      return;
    }

    registerValidSW(swUrl, config);
  });
}

function registerValidSW(swUrl, config) {
  navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      registration.onupdatefound = () => {
        const installingWorker = registration.installing;

        if (!installingWorker) {
          return;
        }

        installingWorker.onstatechange = () => {
          if (installingWorker.state === "installed") {
            if (navigator.serviceWorker.controller) {
              if (config && config.onUpdate) {
                config.onUpdate(registration);
              }
            } else if (config && config.onSuccess) {
              config.onSuccess(registration);
            }
          }
        };
      };
    })
    .catch((error) => {
      console.error("Service worker registration failed:", error);
    });
}

function checkValidServiceWorker(swUrl, config) {
  fetch(swUrl, {
    headers: { "Service-Worker": "script" }
  })
    .then((response) => {
      const contentType = response.headers.get("content-type");

      if (response.status === 404 || (contentType && contentType.indexOf("javascript") === -1)) {
        navigator.serviceWorker.ready.then((registration) => {
          registration.unregister().then(() => {
            window.location.reload();
          });
        });
      } else {
        registerValidSW(swUrl, config);
      }
    })
    .catch(() => {
      console.log("No internet connection found. App is running in offline mode.");
    });
}

export function unregister() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
      })
      .catch((error) => {
        console.error("Service worker unregistration failed:", error);
      });
  }
}
