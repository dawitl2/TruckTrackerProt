# Render Deployment Checklist

This deployment runs Truck Tracker as one Express app:

- Express serves `frontend/build`
- Express proxies GPS at `/gps-proxy`
- Express handles shortcut uploads at `/api/import`

## Render Settings

Create a Render Web Service from this repository.

- Environment: `Node`
- Build command: `npm run render-build`
- Start command: `npm start`
- Node version: `20`

The same settings are also in `render.yaml`.

## Render Environment Variables

Add these in Render under Environment:

- `SUPABASE_URL`
- `SUPABASE_KEY`

Use the same Supabase URL and publishable key already used by the frontend.

Optional:

- `SUPABASE_SERVICE_ROLE_KEY` if you prefer server-side imports to use a service role key
- `CORS_ORIGIN` only if you later need to restrict API callers

## URL Swaps

Use the Render URL as the public app URL instead of the Vercel URL.

Old:

```text
https://truck-tracker-six.vercel.app
```

New:

```text
https://YOUR-RENDER-SERVICE.onrender.com
```

If an iPhone Shortcut posts Excel files to `/api/import`, update it to:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/import
```

## Smoke Tests

After Render deploys, open these:

```text
https://YOUR-RENDER-SERVICE.onrender.com/
https://YOUR-RENDER-SERVICE.onrender.com/gps-proxy/tracking?plate=3-A06725%2F3-32431
```

The GPS test should show the GPS site, not Truck Tracker.
