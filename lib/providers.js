// Where the weather comes from.
//
// The point of this app is that no single company can switch it off, so the
// data layer is deliberately plural and degrades one step at a time:
//
//   Open-Meteo      the backbone. No API key at all, high-resolution models
//                   picked per location, and an archive back to 1940 which
//                   is what makes Time Machine free.
//   Pirate Weather  optional. If PIRATE_WEATHER_API_KEY is set it replaces
//                   the next hour with a genuine radar-derived minutely
//                   series. Everything else still comes from Open-Meteo, so
//                   losing the key costs fidelity, never function.
//   weather.gov     optional, United States only, no key. Government alert
//                   feed. A failure here never touches the forecast.
//
// Every upstream call is time-boxed and cached, and every one of them is
// allowed to fail: a caller gets a partial answer rather than an exception.

const nowcast = require('./nowcast');
const wmo = require('./wmo');

const UA = 'ClearSkies (Usernode app; open weather client)';
const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- cache ---

// Upstream forecasts change every few minutes at best, and Open-Meteo asks
// politely that clients not re-request the same point in a tight loop. A tiny
// in-process cache is enough: containers are single-process and short-lived.
const cache = new Map();
const MAX_ENTRIES = 400;

function cached(key, ttlMs, produce) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve()
    .then(produce)
    .catch(err => { cache.delete(key); throw err; });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function getJson(url, headers) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...(headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('upstream ' + res.status + ' ' + body.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ------------------------------------------------------------- helpers ---

// Open-Meteo returns wall-clock strings in the location's own timezone plus
// the offset that produced them. Reading one back as a real instant means
// parsing it as UTC and then removing that offset.
function parseLocal(stamp, offsetSeconds) {
  if (!stamp) return null;
  let iso = String(stamp);
  if (iso.length === 10) iso += 'T00:00';   // a bare date
  if (iso.length === 16) iso += ':00';      // no seconds
  const t = Date.parse(iso + 'Z');
  if (!Number.isFinite(t)) return null;
  return t - (offsetSeconds || 0) * 1000;
}

function num(v) { return Number.isFinite(v) ? v : null; }

function round(v, places) {
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, places || 0);
  return Math.round(v * f) / f;
}

function coordKey(lat, lon) {
  return Number(lat).toFixed(3) + ',' + Number(lon).toFixed(3);
}

// ------------------------------------------------------------ geocoding ---

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

function geocode(query, language) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return Promise.resolve([]);
  const lang = /^[a-z]{2}$/i.test(language || '') ? language.toLowerCase() : 'en';
  const url = GEOCODE_URL + '?name=' + encodeURIComponent(q) +
    '&count=8&language=' + lang + '&format=json';

  return cached('geo:' + lang + ':' + q.toLowerCase(), 60 * 60 * 1000, async () => {
    const data = await getJson(url);
    return (data.results || []).map(r => ({
      id: r.id,
      name: r.name,
      // "Paris, Ile-de-France, France" reads better than four ambiguous
      // entries all called Paris.
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      country: r.country || null,
      countryCode: r.country_code || null,
      lat: round(r.latitude, 4),
      lon: round(r.longitude, 4),
      timezone: r.timezone || null,
    }));
  });
}

// ------------------------------------------------------------- forecast ---

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

const CURRENT_VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'precipitation', 'weather_code', 'cloud_cover', 'surface_pressure',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'is_day',
].join(',');

const MINUTELY_VARS = ['precipitation', 'snowfall', 'weather_code'].join(',');

const HOURLY_VARS = [
  'temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'weather_code', 'wind_speed_10m', 'relative_humidity_2m',
  'is_day',
].join(',');

const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max',
  'uv_index_max', 'sunrise', 'sunset',
].join(',');

function forecastUrl(lat, lon) {
  return FORECAST_URL +
    '?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&current=' + CURRENT_VARS +
    '&minutely_15=' + MINUTELY_VARS +
    '&hourly=' + HOURLY_VARS +
    '&daily=' + DAILY_VARS +
    '&timezone=auto&forecast_days=7&past_hours=1';
}

async function forecast(lat, lon) {
  return cached('fc:' + coordKey(lat, lon), 4 * 60 * 1000, async () => {
    const data = await getJson(forecastUrl(lat, lon));
    const shaped = shapeForecast(data);
    // Upgrade the next hour to radar if a Pirate Weather key is configured.
    // This is the only place fidelity depends on a secret, and a miss here
    // is silent by design.
    const radar = await pirateMinutely(lat, lon).catch(() => null);
    if (radar) {
      shaped.nowcast = radar.nowcast;
      shaped.nowcastSource = 'pirate-weather';
    }
    return shaped;
  });
}

function shapeForecast(data) {
  const off = data.utc_offset_seconds || 0;
  const cur = data.current || {};
  const isDay = cur.is_day !== 0;

  const place = {
    lat: round(data.latitude, 4),
    lon: round(data.longitude, 4),
    timezone: data.timezone || 'UTC',
    timezoneAbbr: data.timezone_abbreviation || null,
    utcOffsetSeconds: off,
    elevation: num(data.elevation),
  };

  const current = {
    time: parseLocal(cur.time, off),
    temp: num(cur.temperature_2m),
    apparentTemp: num(cur.apparent_temperature),
    humidity: num(cur.relative_humidity_2m),
    precip: num(cur.precipitation),
    cloudCover: num(cur.cloud_cover),
    pressure: num(cur.surface_pressure),
    windSpeed: num(cur.wind_speed_10m),
    windGust: num(cur.wind_gusts_10m),
    windDirection: num(cur.wind_direction_10m),
    isDay,
    condition: wmo.describeAt(cur.weather_code, isDay),
  };

  return {
    place,
    current,
    nowcast: buildNowcast(data, off),
    nowcastSource: 'open-meteo',
    hourly: shapeHourly(data.hourly, off),
    daily: shapeDaily(data.daily, off),
    fetchedAt: Date.now(),
  };
}

// Slice the 15-minute series down to the hour that starts now, then hand it
// to the nowcast engine.
function buildNowcast(data, off) {
  const m = data.minutely_15;
  if (!m || !Array.isArray(m.time)) return null;
  const now = Date.now();
  const buckets = [];
  for (let i = 0; i < m.time.length; i++) {
    const endsAt = parseLocal(m.time[i], off);
    if (endsAt == null || endsAt <= now - 20 * 60 * 1000) continue;
    if (endsAt > now + 90 * 60 * 1000) break;
    const mm = m.precipitation && m.precipitation[i];
    if (!Number.isFinite(mm)) continue;
    const snow = m.snowfall && m.snowfall[i];
    const code = m.weather_code && m.weather_code[i];
    // Snowfall is reported in cm; any at all means the precipitation in this
    // bucket is frozen, whatever the code says.
    const kind = Number.isFinite(snow) && snow > 0
      ? 'snow'
      : (Number.isFinite(code) ? wmo.precipKindForCode(code) : null);
    buckets.push({ endsAt, mm, kind });
  }
  return nowcast.fromQuarterHours(buckets, now);
}

function shapeHourly(h, off) {
  if (!h || !Array.isArray(h.time)) return [];
  const cutoff = Date.now() - 30 * 60 * 1000;
  const out = [];
  for (let i = 0; i < h.time.length && out.length < 48; i++) {
    const t = parseLocal(h.time[i], off);
    if (t == null || t < cutoff) continue;
    const day = h.is_day ? h.is_day[i] !== 0 : true;
    out.push({
      t,
      temp: num(h.temperature_2m && h.temperature_2m[i]),
      apparentTemp: num(h.apparent_temperature && h.apparent_temperature[i]),
      precipProb: num(h.precipitation_probability && h.precipitation_probability[i]),
      precip: num(h.precipitation && h.precipitation[i]),
      humidity: num(h.relative_humidity_2m && h.relative_humidity_2m[i]),
      windSpeed: num(h.wind_speed_10m && h.wind_speed_10m[i]),
      condition: wmo.describeAt(h.weather_code && h.weather_code[i], day),
    });
  }
  return out;
}

function shapeDaily(d, off) {
  if (!d || !Array.isArray(d.time)) return [];
  return d.time.map((stamp, i) => ({
    t: parseLocal(stamp, off),
    date: stamp,
    tempMax: num(d.temperature_2m_max && d.temperature_2m_max[i]),
    tempMin: num(d.temperature_2m_min && d.temperature_2m_min[i]),
    precipSum: num(d.precipitation_sum && d.precipitation_sum[i]),
    precipProb: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
    windMax: num(d.wind_speed_10m_max && d.wind_speed_10m_max[i]),
    uvMax: num(d.uv_index_max && d.uv_index_max[i]),
    sunrise: parseLocal(d.sunrise && d.sunrise[i], off),
    sunset: parseLocal(d.sunset && d.sunset[i], off),
    condition: wmo.describe(d.weather_code && d.weather_code[i]),
  }));
}

// ------------------------------------------------- pirate weather (opt) ---

function pirateKey() {
  const k = (process.env.PIRATE_WEATHER_API_KEY || '').trim();
  return k && !/^(your|changeme|unset)/i.test(k) ? k : null;
}

async function pirateMinutely(lat, lon) {
  const key = pirateKey();
  if (!key) return null;
  return cached('pw:' + coordKey(lat, lon), 4 * 60 * 1000, async () => {
    const url = 'https://api.pirateweather.net/forecast/' + encodeURIComponent(key) +
      '/' + encodeURIComponent(lat) + ',' + encodeURIComponent(lon) +
      '?units=si&exclude=daily,hourly,alerts,flags';
    const data = await getJson(url);
    const rows = data && data.minutely && data.minutely.data;
    if (!Array.isArray(rows) || rows.length < 60) return null;
    const entries = rows.slice(0, 60).map(r => ({
      mmPerHour: Number(r.precipIntensity) || 0,
      kind: r.precipType && r.precipType !== 'none' ? r.precipType : null,
    }));
    const n = nowcast.fromMinutes(entries);
    return n ? { nowcast: n } : null;
  });
}

// -------------------------------------------------------- time machine ---

// Open-Meteo splits history across two endpoints: the reanalysis archive is
// authoritative but lags real time by about five days, while the forecast
// endpoint keeps roughly the last three months of its own past. Pick whichever
// actually holds the day being asked for, so the picker can span 1940 to
// tomorrow with no gap in the middle.
const HISTORY_DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'temperature_2m_mean', 'precipitation_sum', 'rain_sum', 'snowfall_sum',
  'wind_speed_10m_max', 'sunrise', 'sunset',
].join(',');

const HISTORY_HOURLY = [
  'temperature_2m', 'precipitation', 'weather_code', 'wind_speed_10m',
  'relative_humidity_2m', 'is_day',
].join(',');

// The archive lags by about five days; ten is a safe side of that seam.
function historySource(date) {
  const ageDays = (Date.now() - Date.parse(date + 'T12:00:00Z')) / 86400000;
  return ageDays > 10 ? 'archive' : 'forecast';
}

function historyUrl(lat, lon, date) {
  const base = historySource(date) === 'archive' ? ARCHIVE_URL : FORECAST_URL;
  return base +
    '?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&start_date=' + date + '&end_date=' + date +
    '&daily=' + HISTORY_DAILY +
    '&hourly=' + HISTORY_HOURLY +
    '&timezone=auto';
}

function history(lat, lon, date) {
  return cached('hist:' + coordKey(lat, lon) + ':' + date, 12 * 60 * 60 * 1000, async () => {
    const data = await getJson(historyUrl(lat, lon, date));
    const off = data.utc_offset_seconds || 0;
    const d = data.daily || {};
    const hourly = shapeHourly2(data.hourly, off);
    const day = {
      date,
      tempMax: num(d.temperature_2m_max && d.temperature_2m_max[0]),
      tempMin: num(d.temperature_2m_min && d.temperature_2m_min[0]),
      tempMean: num(d.temperature_2m_mean && d.temperature_2m_mean[0]),
      precipSum: num(d.precipitation_sum && d.precipitation_sum[0]),
      rainSum: num(d.rain_sum && d.rain_sum[0]),
      snowSum: num(d.snowfall_sum && d.snowfall_sum[0]),
      windMax: num(d.wind_speed_10m_max && d.wind_speed_10m_max[0]),
      sunrise: parseLocal(d.sunrise && d.sunrise[0], off),
      sunset: parseLocal(d.sunset && d.sunset[0], off),
      condition: wmo.describe(d.weather_code && d.weather_code[0]),
    };
    const hasData = day.tempMax != null || hourly.some(h => h.temp != null);
    return {
      place: {
        lat: round(data.latitude, 4),
        lon: round(data.longitude, 4),
        timezone: data.timezone || 'UTC',
        utcOffsetSeconds: off,
      },
      date,
      day,
      hourly,
      hasData,
      source: historySource(date),
    };
  });
}

// The history endpoints hand back a full day rather than a window starting
// now, so this keeps every hour instead of trimming to the future.
function shapeHourly2(h, off) {
  if (!h || !Array.isArray(h.time)) return [];
  return h.time.map((stamp, i) => ({
    t: parseLocal(stamp, off),
    temp: num(h.temperature_2m && h.temperature_2m[i]),
    precip: num(h.precipitation && h.precipitation[i]),
    humidity: num(h.relative_humidity_2m && h.relative_humidity_2m[i]),
    windSpeed: num(h.wind_speed_10m && h.wind_speed_10m[i]),
    condition: wmo.describeAt(
      h.weather_code && h.weather_code[i],
      h.is_day ? h.is_day[i] !== 0 : true
    ),
  }));
}

// -------------------------------------------------------------- alerts ---

// United States only, and entirely optional: the forecast is requested and
// rendered without waiting for this.
function alerts(lat, lon) {
  return cached('alerts:' + coordKey(lat, lon), 5 * 60 * 1000, async () => {
    const url = 'https://api.weather.gov/alerts/active?status=actual&point=' +
      encodeURIComponent(Number(lat).toFixed(4) + ',' + Number(lon).toFixed(4));
    const data = await getJson(url, { accept: 'application/geo+json' });
    return (data.features || []).slice(0, 6).map(f => {
      const p = f.properties || {};
      return {
        id: p.id || f.id || null,
        event: p.event || 'Weather alert',
        headline: p.headline || null,
        severity: p.severity || 'Unknown',
        urgency: p.urgency || null,
        description: (p.description || '').slice(0, 2000),
        instruction: (p.instruction || '').slice(0, 1000),
        onset: p.onset ? Date.parse(p.onset) : null,
        ends: p.ends ? Date.parse(p.ends) : (p.expires ? Date.parse(p.expires) : null),
        sender: p.senderName || null,
      };
    });
  });
}

module.exports = {
  geocode, forecast, history, alerts,
  hasRadarKey: () => Boolean(pirateKey()),
  __test: { parseLocal, shapeForecast, buildNowcast },
};
