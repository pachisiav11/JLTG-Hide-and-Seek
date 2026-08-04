# Deploy the JLTG backend (Overpass proxy + multiplayer relay)

The live site (`https://jltg-map-companion.onrender.com`) is a **Static Site** and has
**no backend**, so two features are currently inert in production:

- **Overpass fallback** — when Google Places returns thin/failed category results,
  the client can fall back to OpenStreetMap via a proxy. Gated on `OVERPASS_PROXY_URL`.
- **Live multiplayer** (Phase 13) — Socket.IO session relay. Gated on `MULTIPLAYER_URL`
  (which falls back to `OVERPASS_PROXY_URL`).

Both are served by the **same** Node/Express service ([`server.js`](server.js)). Turning
them on is a **Render-dashboard action a human must do** — it can't be done from the repo.
This file is the exact runbook.

> **You cannot do this from code.** Deploying a Render service and setting its env vars,
> then setting the Static Site's env vars, are dashboard operations. The steps below are
> what to click; there are **no real backend URLs to invent** — Render assigns the URL
> when you create the service, and you paste that assigned URL back into the Static Site.

---

## What the code already provides (verified)

**Server entrypoint** — [`server.js`](server.js), started by `npm start`:

- `package.json` → `"start": "node server.js"`, `"type": "module"`, `engines.node >= 18`,
  deps `express` + `socket.io`.
- Listens on `process.env.PORT` (Render injects `PORT`; local default `3000`).
- Routes: `GET /health` → `{ok:true}` · `GET /overpass?category=…&bbox=S,W,N,E` ·
  Socket.IO relay mounted at `/socket.io` (rooms keyed by session code; in-memory only).
- CORS: both the Express middleware and the Socket.IO server use
  `process.env.ALLOW_ORIGIN` (default `*`). Set it to the Static Site origin in prod.

**Client consumption of the URLs** (read from `window.JLTG_CONFIG`, i.e. `config.js`):

| Env var | Written into `config.js` by | Read by | Purpose |
|---|---|---|---|
| `OVERPASS_PROXY_URL` | [`scripts/build-config.js`](scripts/build-config.js) | [`src/places.js`](src/places.js) (`window.JLTG_CONFIG.OVERPASS_PROXY_URL`) | Overpass fallback base URL; unset = Google-only |
| `MULTIPLAYER_URL` | [`scripts/build-config.js`](scripts/build-config.js) | [`src/sync.js`](src/sync.js) `backendUrl()` = `MULTIPLAYER_URL \|\| OVERPASS_PROXY_URL` | Multiplayer relay base URL |

The multiplayer client ([`src/sync.js`](src/sync.js)) uses that base URL two ways, so the
backend must be reachable at the exact origin you configure:

1. Loads the Socket.IO **browser client** from `<base>/socket.io/socket.io.js`.
2. Connects with `io(base, { transports: ["websocket", "polling"] })`.

So `MULTIPLAYER_URL` / `OVERPASS_PROXY_URL` must be the backend's **origin only** — no
trailing slash, no path (e.g. `https://jltg-backend.onrender.com`, **not**
`…/socket.io` or `…/`).

---

## Step 1 — Create the backend Web Service on Render

Either apply the Blueprint or create the service manually; both produce the same service
(the second `type: web` entry in [`render.yaml`](render.yaml)).

**Manual (New ▸ Web Service):**

| Field | Value |
|---|---|
| Repo / branch | this repo · `main` |
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/health` |
| Plan | Free (fine for casual play; see cold-start note) |
| Instance | single instance |

Do **not** set `PORT` yourself — Render provides it and `server.js` reads it.

After the first deploy, note the URL Render assigns, e.g.
`https://jltg-backend.onrender.com` (yours will differ). This is the value you paste in
Steps 2–3. **Verify it:** open `https://<assigned-url>/health` → it must return
`{"ok":true}`.

## Step 2 — Set the backend's env var

In the backend service's **Environment** tab:

| Key | Value | Why |
|---|---|---|
| `ALLOW_ORIGIN` | `https://jltg-map-companion.onrender.com` | Locks CORS + Socket.IO to the Static Site origin. Exact origin, no trailing slash. |

(You may leave it unset during a first smoke test — it defaults to `*` — but set it before
real use so the relay isn't open to any origin.)

Redeploy the backend after changing env vars.

## Step 3 — Point the Static Site at the backend

In the **Static Site** service (`jltg-map-companion`) **Environment** tab, add whichever
features you want, then trigger a redeploy (the build re-runs
`node scripts/build-config.js`, baking the values into `config.js`):

| Key | Value | Enables |
|---|---|---|
| `MULTIPLAYER_URL` | `https://<assigned-backend-url>` | Live multiplayer (📡 menu) |
| `OVERPASS_PROXY_URL` | `https://<assigned-backend-url>` | Overpass fallback (and multiplayer, since `MULTIPLAYER_URL` falls back to it) |

Setting **either** one to the backend origin is enough for multiplayer; set
`OVERPASS_PROXY_URL` too if you also want the Places→OSM fallback. Same origin for both.

## Step 4 — Verify end to end

1. `GET https://<backend>/health` → `{"ok":true}`.
2. `GET https://<backend>/overpass?category=hospital&bbox=1.24,103.6,1.47,104.0` →
   `{"source":"overpass","count":…,"features":[…]}` (Overpass path).
3. On the live site, open **☰ ▸ 📡 Multiplayer**. If the URLs are baked in it shows
   Create/Join; **Create** should produce a session code with no "not configured" notice.
   Open the site in a second browser, **Join** with that code, and confirm a zone/question
   added on one device appears on the other. (First connect after idle may lag — see below.)

---

## v2 deploy status (2026-08-04)

Both Render services are defined in [`render.yaml`](render.yaml) and neither sets
`autoDeploy: false`, so **Render's default applies: both auto-deploy on a push to the
connected branch.** The v2 build was pushed to `main`, so both should already have picked it
up — no manual action is normally needed.

If a deploy needs forcing (a failed build, a service pointed at a different branch), it has to
be done from the Render dashboard: **Manual Deploy ▸ Deploy latest commit** on each service, or
via a Deploy Hook URL. There is no Render API key or deploy hook in this repo, and none should
be committed.

### What was verified locally at the v2 head commit

Both services' Render commands were run against this commit before it was pushed, because a
build or start failure only shows up as a red deploy otherwise:

| Service | Render command | Result |
|---|---|---|
| `jltg-hide-and-seek` (static) | `node scripts/build-config.js` | ✅ wrote `config.js` (key + mapId present) |
| `jltg-backend` (node) | `npm install` | ✅ 349 packages, exit 0 |
| `jltg-backend` | `npm start` | ✅ listening; `[fcm]` degrades gracefully with no service account |
| `jltg-backend` | `GET /health` (Render's `healthCheckPath`) | ✅ `{"ok":true}` |

The `/overpass` category endpoint was also exercised, since v2 edited its tag map. `park`,
`mountain`, `mcdonalds` and `seven_eleven` are all **accepted** (they reach the upstream fetch),
while `bogus_category` is still rejected with `400 Unknown category` — so the two new
`brand:wikidata` entries are wired correctly and validation still works. The server stayed up
with nothing logged as an error.

Upstream Overpass itself is unreachable from the build sandbox, so the accepted requests hang
rather than returning data. That is the sandbox's network policy, not a service fault — and it
is exactly why the client keeps a 30-day IndexedDB cache with a stale-cache fallback.

## Notes / gotchas

- **WebSockets**: Render Web Services support WebSockets by default; no extra config. The
  client also allows `polling` transport as a fallback.
- **Free-tier cold start**: a free Web Service sleeps when idle; the first request after
  idle takes ~30–60 s to wake. The client's offline outbox means edits aren't lost while
  it wakes, but the very first multiplayer connect after idle can be slow. Upgrade the
  instance if that's not acceptable.
- **Relay, not a store**: the server keeps only ephemeral in-memory session state (last
  snapshot + membership). If it restarts/sleeps, clients recover because the host
  re-offers a snapshot on the next join. No database, no API key on the backend.
- **CORS symmetry**: `ALLOW_ORIGIN` (backend) and the Static Site origin must match
  exactly, including scheme. A mismatch fails the Socket.IO handshake silently.
- **Config safety**: never commit `config.js` — it's generated from env at build time and
  git-ignored. These URLs are set in the Render dashboard, not in the repo.
