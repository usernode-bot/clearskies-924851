// A deterministic, obviously-fake forecast for `?demo=1`.
//
// It exists for two reasons. Staging previews and the platform's automated
// checks run wherever the build worker happens to live, and an app whose
// every screen depends on a live third-party API is an app whose screenshots
// are a coin toss. And a person opening the preview to vote should see the
// nowcast doing the thing it was built to do, not "no rain for the next
// hour" in whatever city the fixture picked.
//
// So this generates a plausible afternoon with a shower arriving shortly,
// anchored to the real clock so the times on screen read correctly. It is
// shaped exactly like a real provider response and goes through the real
// nowcast engine, so the demo screen exercises the same code as the live one.
// Nothing here is written to the database and nothing is user-specific.

const nowcast = require('./nowcast');
const wmo = require('./wmo');

const HOUR = 3600 * 1000;

// A fixed-seed generator, so two loads of the demo look the same and a
// screenshot diff is meaningful.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PLACE = {
  name: 'Cascadia Heights',
  region: 'ClearSkies demo location',
  lat: 47.6062,
  lon: -122.3321,
};

// A shower that arrives in about twenty minutes and clears before the hour
// is out: the exact case the nowcast sentence was invented for.
function demoMinutes() {
  const out = [];
  for (let m = 0; m < 60; m++) {
    let mmPerHour = 0;
    if (m >= 19 && m < 47) {
      // Ramp in over five minutes, hold, then taper.
      const into = m - 19;
      const left = 47 - m;
      const ramp = Math.min(1, into / 5, left / 7);
      mmPerHour = 3.4 * ramp;
    }
    out.push({ mmPerHour: Math.round(mmPerHour * 100) / 100, kind: mmPerHour > 0 ? 'rain' : null });
  }
  return out;
}

// A gentle diurnal temperature curve: coldest before dawn, warmest mid
// afternoon.
function tempAt(hourOfDay, base, swing) {
  return base + swing * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
}

function forecast() {
  const now = Date.now();
  const topOfHour = Math.floor(now / HOUR) * HOUR;
  const rand = rng(20260828);

  const hourly = [];
  for (let i = 0; i < 48; i++) {
    const t = topOfHour + i * HOUR;
    const hourOfDay = new Date(t).getUTCHours();
    const temp = Math.round(tempAt(hourOfDay, 13.5, 5.5) * 10) / 10;
    // The demo shower sits in the current hour; a second front arrives
    // overnight so the 7-day column is not a flat line.
    const showerNow = i === 0 || i === 1;
    const frontLater = i >= 14 && i <= 19;
    const prob = showerNow ? 78 : frontLater ? 60 + Math.round(rand() * 25) : Math.round(rand() * 22);
    const precip = showerNow ? 0.9 : frontLater ? Math.round(rand() * 18) / 10 : 0;
    const isDay = hourOfDay >= 7 && hourOfDay < 20;
    const code = precip > 1 ? 63 : precip > 0 ? 61 : prob > 40 ? 3 : isDay ? 2 : 1;
    hourly.push({
      t,
      temp,
      apparentTemp: Math.round((temp - 1.2) * 10) / 10,
      precipProb: prob,
      precip,
      humidity: 60 + Math.round(rand() * 25),
      windSpeed: 8 + Math.round(rand() * 14),
      condition: wmo.describeAt(code, isDay),
    });
  }

  // Today's high and low are read off the hours themselves, so the hero, the
  // timeline and the week cannot contradict each other on screen.
  const todayHours = hourly.slice(0, 24).map(h => h.temp);
  const nowTemp = Math.round(tempAt(new Date(now).getUTCHours(), 13.5, 5.5) * 10) / 10;

  const startOfDay = Math.floor(now / (24 * HOUR)) * 24 * HOUR;
  const daily = [];
  // Each day's icon, chance and total are derived from one weather code, so a
  // sunny glyph can never sit beside a 90% chance of rain on the same row.
  const CODES = [61, 3, 2, 80, 1, 0, 63];
  const WET = { 61: [65, 4], 63: [85, 9], 80: [70, 5] };
  for (let i = 0; i < 7; i++) {
    const t = startOfDay + i * 24 * HOUR;
    const drift = Math.sin(i / 2) * 3;
    const max = i === 0
      ? Math.max.apply(null, todayHours)
      : Math.round((17 + drift) * 10) / 10;
    const min = i === 0
      ? Math.min.apply(null, todayHours)
      : Math.round((max - 6 - rand() * 3) * 10) / 10;
    const code = CODES[i];
    const wet = WET[code];
    const overcast = code === 3;
    daily.push({
      t,
      date: new Date(t).toISOString().slice(0, 10),
      tempMax: max,
      tempMin: min,
      precipSum: wet ? Math.round((wet[1] + rand() * 3) * 10) / 10 : (overcast ? 0.2 : 0),
      precipProb: wet
        ? wet[0] + Math.round(rand() * 12)
        : (overcast ? 20 + Math.round(rand() * 15) : Math.round(rand() * 10)),
      windMax: 12 + Math.round(rand() * 20),
      // Bright days carry the higher index, as they do in life.
      uvMax: wet ? Math.round(rand() * 25) / 10 : Math.round((4 + rand() * 4) * 10) / 10,
      sunrise: t + 6.4 * HOUR,
      sunset: t + 20.1 * HOUR,
      condition: wmo.describe(code),
    });
  }

  return {
    demo: true,
    place: {
      lat: PLACE.lat,
      lon: PLACE.lon,
      timezone: 'UTC',
      timezoneAbbr: 'UTC',
      utcOffsetSeconds: 0,
      elevation: 56,
    },
    current: {
      time: now,
      temp: nowTemp,
      apparentTemp: Math.round((nowTemp - 1.4) * 10) / 10,
      humidity: 74,
      precip: 0,
      cloudCover: 68,
      pressure: 1011,
      windSpeed: 14,
      windGust: 27,
      windDirection: 215,
      isDay: true,
      condition: wmo.describeAt(2, true),
    },
    nowcast: nowcast.fromMinutes(demoMinutes()),
    nowcastSource: 'demo',
    hourly,
    daily,
    fetchedAt: now,
  };
}

// Time Machine needs an answer for any date the picker can reach, so the
// demo derives one from the date itself: the same day always looks the same.
function history(date) {
  const rand = rng(hashString(String(date)));
  const seasonal = Math.cos(((new Date(date + 'T12:00:00Z').getUTCMonth() + 0.5) / 12) * 2 * Math.PI);
  const base = 13 - seasonal * 9;
  const start = Date.parse(date + 'T00:00:00Z');
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const temp = Math.round(tempAt(h, base, 5) * 10) / 10;
    const precip = rand() > 0.78 ? Math.round(rand() * 25) / 10 : 0;
    hourly.push({
      t: start + h * HOUR,
      temp,
      precip,
      humidity: 55 + Math.round(rand() * 35),
      windSpeed: 5 + Math.round(rand() * 20),
      condition: wmo.describeAt(precip > 1 ? 63 : precip > 0 ? 61 : 2, h >= 7 && h < 20),
    });
  }
  const temps = hourly.map(h => h.temp);
  const precipSum = Math.round(hourly.reduce((s, h) => s + h.precip, 0) * 10) / 10;
  return {
    demo: true,
    place: { lat: PLACE.lat, lon: PLACE.lon, timezone: 'UTC', utcOffsetSeconds: 0 },
    date,
    day: {
      date,
      tempMax: Math.max(...temps),
      tempMin: Math.min(...temps),
      tempMean: Math.round((temps.reduce((s, t) => s + t, 0) / temps.length) * 10) / 10,
      precipSum,
      rainSum: precipSum,
      snowSum: 0,
      windMax: Math.max(...hourly.map(h => h.windSpeed)),
      sunrise: start + 6.6 * HOUR,
      sunset: start + 19.8 * HOUR,
      condition: wmo.describe(precipSum > 4 ? 63 : precipSum > 0 ? 61 : 2),
    },
    hourly,
    hasData: true,
    source: 'demo',
  };
}

// Search results for the demo, so the place picker is explorable without a
// network round trip.
const PLACES = [
  { id: 1, name: 'Cascadia Heights', region: 'ClearSkies demo location', country: 'Demoland', countryCode: 'XX', lat: 47.6062, lon: -122.3321, timezone: 'UTC' },
  { id: 2, name: 'Port Meridian', region: 'ClearSkies demo location', country: 'Demoland', countryCode: 'XX', lat: 40.7128, lon: -74.006, timezone: 'UTC' },
  { id: 3, name: 'Fenwick Bay', region: 'ClearSkies demo location', country: 'Demoland', countryCode: 'XX', lat: 51.5072, lon: -0.1276, timezone: 'UTC' },
];

function geocode(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return PLACES;
  return PLACES.filter(p => p.name.toLowerCase().includes(q));
}

function alerts() {
  return [{
    id: 'demo-alert-1',
    event: 'Wind Advisory',
    headline: 'Wind Advisory in effect until this evening',
    severity: 'Moderate',
    urgency: 'Expected',
    description: 'Sample alert used by the ClearSkies demo screen. Southwest winds 25 to 35 km/h with gusts up to 60 km/h are expected through the afternoon.',
    instruction: 'Secure loose objects outdoors. Use extra care when driving a high-profile vehicle.',
    onset: Date.now() - HOUR,
    ends: Date.now() + 5 * HOUR,
    sender: 'ClearSkies demo',
  }];
}

module.exports = { forecast, history, geocode, alerts, PLACE, PLACES };
