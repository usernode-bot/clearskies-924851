const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const providers = require('./lib/providers');
const demo = require('./lib/demo');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform's address, injected by the platform at deploy. Never written
// out here: a hardcoded hostname is what broke this app when the platform
// moved domains. Empty only outside the platform (local `node server.js`),
// where there is no platform to send anyone to.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '').replace(/\/+$/, '');
const PLATFORM_APP_URL = PLATFORM_ORIGIN ? PLATFORM_ORIGIN + '/app/clearskies-924851/full' : '';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
//
// The /api/demo/* routes are deliberately public. They serve a synthetic,
// hard-coded forecast (lib/demo.js) with no database access and no user data
// in it at all, which is what lets the staging preview, the platform's
// automated checks and the before/after screenshots render the real screen
// without depending on a third-party weather API being reachable from
// wherever the build worker runs.
const PUBLIC_API_PATHS = new Set([
  '/health',
  '/api/demo/forecast',
  '/api/demo/geocode',
  '/api/demo/timemachine',
  '/api/demo/alerts',
  '/api/demo/places',
]);

app.use(express.json({ limit: '16kb' }));

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

// The app ships no favicon file; index.html carries an inline SVG icon
// instead. Answer 204 here so anything that still probes /favicon.ico
// doesn't fall through to the auth-gated catch-all and surface a 401 in the
// console on every fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ------------------------------------------------------------ validation ---

function coords(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) {
    res.status(400).json({ error: 'A latitude and longitude are required.' });
    return null;
  }
  return { lat, lon };
}

// Time Machine reaches back to the start of the reanalysis record and a
// fortnight forward, which is the whole span the two Open-Meteo endpoints
// can answer for between them.
const EARLIEST_DATE = '1940-01-01';

function validDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(date + 'T12:00:00Z');
  if (!Number.isFinite(t)) return null;
  if (date < EARLIEST_DATE) return null;
  if (t > Date.now() + 15 * 86400000) return null;
  return date;
}

// Upstream weather services are outside this app's control, so a failure
// there is reported as exactly that rather than as a bug in the app.
function upstreamFailed(res, err) {
  const status = err && err.status === 429 ? 429 : 502;
  res.status(status).json({
    error: status === 429
      ? 'The weather service is rate limiting us. Try again shortly.'
      : 'The weather service could not be reached. Try again shortly.',
  });
}

// ------------------------------------------------------------- live data ---

app.get('/api/forecast', async (req, res) => {
  const c = coords(req, res);
  if (!c) return;
  try {
    const data = await providers.forecast(c.lat, c.lon);
    res.json(data);
  } catch (err) {
    upstreamFailed(res, err);
  }
});

app.get('/api/geocode', async (req, res) => {
  try {
    res.json({ results: await providers.geocode(req.query.q, req.query.lang) });
  } catch (err) {
    upstreamFailed(res, err);
  }
});

app.get('/api/timemachine', async (req, res) => {
  const c = coords(req, res);
  if (!c) return;
  const date = validDate(req.query.date);
  if (!date) {
    return res.status(400).json({
      error: 'Pick a date between ' + EARLIEST_DATE + ' and two weeks from now.',
    });
  }
  try {
    res.json(await providers.history(c.lat, c.lon, date));
  } catch (err) {
    upstreamFailed(res, err);
  }
});

// Government alerts are a bonus feed, United States only. A location with no
// coverage answers with an empty list rather than an error, because the
// client renders this beside the forecast and must never be blocked by it.
app.get('/api/alerts', async (req, res) => {
  const c = coords(req, res);
  if (!c) return;
  try {
    res.json({ alerts: await providers.alerts(c.lat, c.lon) });
  } catch {
    res.json({ alerts: [], unavailable: true });
  }
});

// ------------------------------------------------------------ demo data ---

app.get('/api/demo/forecast', (_req, res) => res.json(demo.forecast()));
app.get('/api/demo/geocode', (req, res) => res.json({ results: demo.geocode(req.query.q) }));
app.get('/api/demo/alerts', (_req, res) => res.json({ alerts: demo.alerts() }));
app.get('/api/demo/places', (_req, res) => res.json({
  places: demo.PLACES.map((p, i) => ({
    id: -(i + 1), name: p.name, region: p.region,
    lat: p.lat, lon: p.lon, timezone: p.timezone, position: i,
  })),
}));
app.get('/api/demo/timemachine', (req, res) => {
  const date = validDate(req.query.date) || new Date().toISOString().slice(0, 10);
  res.json(demo.history(date));
});

// --------------------------------------------------------- saved places ---

const MAX_PLACES = 25;

app.get('/api/places', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, region, lat, lon, timezone, position
         FROM saved_places
        WHERE user_id = $1
        ORDER BY position ASC, id ASC`,
      [req.user.id]
    );
    res.json({ places: rows.map(r => ({ ...r, lat: Number(r.lat), lon: Number(r.lon) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/places', async (req, res) => {
  const body = req.body || {};
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const name = String(body.name || '').trim().slice(0, 120);
  const region = String(body.region || '').trim().slice(0, 160) || null;
  const timezone = String(body.timezone || '').trim().slice(0, 64) || null;

  if (!name) return res.status(400).json({ error: 'A place needs a name.' });
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'That place has no usable coordinates.' });
  }

  try {
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM saved_places WHERE user_id = $1', [req.user.id]
    );
    if (countRows[0].n >= MAX_PLACES) {
      return res.status(400).json({ error: 'You can save up to ' + MAX_PLACES + ' places.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO saved_places (user_id, name, region, lat, lon, timezone, position)
       VALUES ($1, $2, $3, $4, $5, $6,
               COALESCE((SELECT MAX(position) + 1 FROM saved_places WHERE user_id = $1), 0))
       ON CONFLICT (user_id, lat, lon) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, region, lat, lon, timezone, position`,
      [req.user.id, name, region, lat.toFixed(4), lon.toFixed(4), timezone]
    );
    const row = rows[0];
    res.json({ place: { ...row, lat: Number(row.lat), lon: Number(row.lon) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/places/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Unknown place.' });
  try {
    await pool.query('DELETE FROM saved_places WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/places/order', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, MAX_PLACES) : null;
  if (!ids || ids.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'Send the place ids in their new order.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        'UPDATE saved_places SET position = $1 WHERE id = $2 AND user_id = $3',
        [i, ids[i], req.user.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Usernode" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    // `/open-in-usernode` is the in-app sign-in link (public/app.js): it
    // means "open the app", so it carries no deep path of its own.
    const deepPath = req.path !== '/open-in-usernode'
      && /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_APP_URL && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_APP_URL + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_APP_URL}${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------- boot ---

async function migrate() {
  // Saved places are home and work coordinates. That is personal information
  // beyond a public username, so the table is marked private: staging gets
  // the schema and none of the rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_places (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name VARCHAR(120) NOT NULL,
      region VARCHAR(160),
      lat NUMERIC(8, 4) NOT NULL,
      lon NUMERIC(9, 4) NOT NULL,
      timezone VARCHAR(64),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE saved_places IS 'staging:private'`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS saved_places_user_point
      ON saved_places (user_id, lat, lon)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS saved_places_user_position
      ON saved_places (user_id, position)
  `);
}

const DRAIN_MS = 3000;
let server;

async function shutdown(signal) {
  if (shuttingDown) return;   // idempotent: SIGTERM then SIGINT must not double-run
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  server = app.listen(port, () => {
    console.log(`Listening on :${port}` + (IS_STAGING ? ' (staging)' : ''));
    if (!providers.hasRadarKey()) {
      console.log('[nowcast] no PIRATE_WEATHER_API_KEY set, using Open-Meteo 15-minute data');
    }
  });
}

start().catch(err => { console.error(err); process.exit(1); });
