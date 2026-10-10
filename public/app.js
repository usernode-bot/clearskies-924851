// ClearSkies.
//
// A Dark Sky replacement whose whole point is that it cannot be bought and
// switched off: the data comes from open sources (see lib/providers.js) and
// the app itself is governed by the group that uses it.
//
// The screen is arranged in the order the original earned its keep:
//   1. the nowcast sentence, which is the product
//   2. the next-hour intensity curve underneath it
//   3. the day timeline, then the week, then the details
//
// Everything the platform hosts (the native kit, the bridge) is treated as
// progressive enhancement. If those files cannot be reached the app still
// renders and every control still works, which is also what keeps the
// automated checks honest.

(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var DEMO = params.get('demo') === '1';

  var API = DEMO ? '/api/demo' : '/api';

  // The shell injects `?token=`. Without one (a stray direct visit) every
  // gated endpoint would answer 401, so the app says what to do instead of
  // making the request and rendering the failure.
  var CAN_CALL_API = Boolean(token) || DEMO;

  var state = {
    view: 'forecast',
    units: 'c',
    place: null,
    forecast: null,
    alerts: [],
    places: [],
    status: 'loading',
    error: null,
    tmDate: todayISO(),
    tmData: null,
    tmStatus: 'idle',
    tmError: null,
    drawn: false,
  };

  // ------------------------------------------------------------- storage ---

  // Preferences are a per-browser convenience, so they live in localStorage
  // rather than the database. Every access is guarded: private windows and
  // blocked site data both throw here rather than returning null.
  function readStore(key) {
    try { return window.localStorage.getItem('clearskies:' + key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { window.localStorage.setItem('clearskies:' + key, value); } catch (e) { /* not fatal */ }
  }

  // ----------------------------------------------------------- utilities ---

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // A lone dash is the placeholder for a value we do not have.
  var MISSING = '—';

  function temp(c) {
    if (c == null || !isFinite(c)) return MISSING;
    return Math.round(state.units === 'f' ? c * 9 / 5 + 32 : c) + '°';
  }

  function tempUnit() { return state.units === 'f' ? 'F' : 'C'; }

  function speed(kmh) {
    if (kmh == null || !isFinite(kmh)) return MISSING;
    return state.units === 'f'
      ? Math.round(kmh * 0.621371) + ' mph'
      : Math.round(kmh) + ' km/h';
  }

  function depth(mm) {
    if (mm == null || !isFinite(mm)) return MISSING;
    if (state.units === 'f') {
      var inches = mm / 25.4;
      return (inches < 0.1 ? inches.toFixed(2) : inches.toFixed(1)) + ' in';
    }
    return (mm < 1 ? mm.toFixed(1) : Math.round(mm)) + ' mm';
  }

  function rate(mmPerHour) {
    if (mmPerHour == null || !isFinite(mmPerHour)) return MISSING;
    return state.units === 'f'
      ? (mmPerHour / 25.4).toFixed(2) + ' in/h'
      : mmPerHour.toFixed(1) + ' mm/h';
  }

  var fmtCache = {};
  function formatter(opts) {
    var tz = (state.forecast && state.forecast.place && state.forecast.place.timezone) || null;
    var key = tz + '|' + JSON.stringify(opts);
    if (fmtCache[key]) return fmtCache[key];
    var full = Object.assign({}, opts);
    if (tz) full.timeZone = tz;
    var f;
    try {
      f = new Intl.DateTimeFormat(undefined, full);
    } catch (e) {
      // An unrecognised zone must not take the page down; fall back to the
      // viewer's own clock.
      f = new Intl.DateTimeFormat(undefined, opts);
    }
    fmtCache[key] = f;
    return f;
  }

  function fmtTime(t) {
    if (!t) return MISSING;
    return formatter({ hour: 'numeric', minute: '2-digit' }).format(new Date(t));
  }
  function fmtHour(t) {
    if (!t) return MISSING;
    return formatter({ hour: 'numeric' }).format(new Date(t));
  }
  function fmtWeekday(t) {
    if (!t) return MISSING;
    return formatter({ weekday: 'short' }).format(new Date(t));
  }
  function fmtLongDate(t) {
    if (!t) return MISSING;
    return formatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(t));
  }

  function windArrow(deg) {
    if (deg == null || !isFinite(deg)) return '';
    var points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return points[Math.round(deg / 45) % 8];
  }

  // ---------------------------------------------------------- native kit ---

  // The kit is centrally hosted, so it can be missing (an offline launch, a
  // host that has not loaded yet). Every use of it goes through here.
  function kit() { return window.unNative || null; }

  function toast(message) {
    var k = kit();
    if (k && k.toast) { k.toast(message); return; }
    var bar = el('fallback-toast');
    if (!bar) return;
    bar.textContent = message;
    bar.classList.remove('hidden');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(function () { bar.classList.add('hidden'); }, 2600);
  }

  // ---------------------------------------------------------------- icons ---

  // Stroked line art in currentColor, so a single icon works on every
  // background in the app.
  var ICONS = {
    'clear': '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>',
    'clear-night': '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/>',
    'mostly-clear': '<circle cx="9.5" cy="9.5" r="3.4"/><path d="M9.5 2.8v1.8M2.8 9.5h1.8M4.9 4.9l1.3 1.3M14.1 4.9l-1.3 1.3"/><path d="M17.5 20H8.6a3.6 3.6 0 0 1-.4-7.2 5 5 0 0 1 9.3 1.6 2.8 2.8 0 0 1 0 5.6z"/>',
    'mostly-clear-night': '<path d="M15.6 9.4A5.6 5.6 0 0 1 9.5 3.3a5.6 5.6 0 1 0 6.1 6.1z"/><path d="M17.5 20H8.6a3.6 3.6 0 0 1-.4-7.2 5 5 0 0 1 9.3 1.6 2.8 2.8 0 0 1 0 5.6z"/>',
    'partly-cloudy': '<circle cx="8.8" cy="8.4" r="3.1"/><path d="M8.8 2.4v1.6M2.8 8.4h1.6M4.4 4l1.2 1.2"/><path d="M17.6 20H8.9a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.5 1.7 2.9 2.9 0 0 1-.4 5.7z"/>',
    'partly-cloudy-night': '<path d="M14.8 8.8a5.2 5.2 0 0 1-5.6-5.6 5.2 5.2 0 1 0 5.6 5.6z"/><path d="M17.6 20H8.9a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.5 1.7 2.9 2.9 0 0 1-.4 5.7z"/>',
    'cloudy': '<path d="M17.6 18.5H7.4a3.9 3.9 0 0 1-.4-7.8 5.4 5.4 0 0 1 10.1 1.8 3 3 0 0 1 .5 6z"/>',
    'fog': '<path d="M17 12.4H7.2a3.5 3.5 0 0 1-.4-7 4.9 4.9 0 0 1 9.2 1.6 2.7 2.7 0 0 1 1 5.4z"/><path d="M4.5 16h15M6.5 19.4h11"/>',
    'drizzle': '<path d="M17.2 14.6H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M9 18v1.6M13 18v2.2M17 18v1.6"/>',
    'rain': '<path d="M17.2 13.6H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M8.6 16.6l-1 3M12.5 16.6l-1 3.8M16.4 16.6l-1 3"/>',
    'heavy-rain': '<path d="M17.2 12.8H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M7.6 15.6l-1.2 4.6M11.4 15.6l-1.2 5.4M15.2 15.6L14 20.2M18.4 15.6l-1 3.4"/>',
    'showers': '<path d="M17.2 13.6H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M9.4 16.4l-1.2 3.4M14.4 16.4l-1.2 3.4"/><circle cx="11.6" cy="20.2" r="0.9"/>',
    'sleet': '<path d="M17.2 13.2H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M9 16.4l-1 3.2M15 16.4l-1 3.2"/><circle cx="12" cy="18.6" r="1"/>',
    'snow': '<path d="M17.2 12.8H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M8.6 17.4h1.2M11.4 19.6h1.2M14.2 17.4h1.2M9.2 20.2h.6M13 15.8h.6"/>',
    'thunderstorm': '<path d="M17.2 12.6H7.4a3.7 3.7 0 0 1-.4-7.4 5.1 5.1 0 0 1 9.6 1.7 2.8 2.8 0 0 1 .6 5.7z"/><path d="M13.4 15l-3.2 4.2h2.8L11.6 23"/>',
  };

  function icon(name, cls) {
    var body = ICONS[name] || ICONS.cloudy;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" class="' + (cls || 'w-6 h-6') +
      '" aria-hidden="true">' + body + '</svg>';
  }

  // ------------------------------------------------------------------ api ---

  function request(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    if (token) headers['x-usernode-token'] = token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function friendlyError(err) {
    if (err && err.status === 401) return 'Open ClearSkies inside Usernode to load the forecast.';
    return (err && err.message) || 'Something went wrong. Try again.';
  }

  // --------------------------------------------------------------- charts ---

  // The next-hour precipitation curve. This is the graph people describe as
  // "glanceable": no axes to read, no numbers to interpret, just the shape of
  // the next sixty minutes with the onset and the let-up marked on it.
  function nowcastChart(nc) {
    var W = 360, H = 116, TOP = 12, BASE = 92;
    var minutes = nc.minutes;
    // Keep a floor on the scale so a light shower does not fill the frame and
    // read as a downpour.
    var scale = Math.max(2.5, nc.peak * 1.2);
    var x = function (i) { return (i / (minutes.length - 1)) * W; };
    var y = function (v) { return TOP + (1 - clamp(v / scale, 0, 1)) * (BASE - TOP); };

    var line = '';
    for (var i = 0; i < minutes.length; i++) {
      line += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(minutes[i]).toFixed(1);
    }
    var area = line + 'L' + W + ' ' + BASE + 'L0 ' + BASE + 'Z';

    // Intensity guides, drawn only where they actually fall inside the frame.
    var guides = '';
    [[7.6, 'heavy'], [2.5, 'moderate'], [0.5, 'light']].forEach(function (g) {
      if (g[0] > scale) return;
      var gy = y(g[0]).toFixed(1);
      guides += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy +
        '" stroke="rgba(148,163,184,0.22)" stroke-width="1" stroke-dasharray="2 4"/>' +
        '<text x="4" y="' + (Number(gy) - 3) + '" fill="rgba(148,163,184,0.65)" font-size="8" ' +
        'letter-spacing="0.6">' + g[1] + '</text>';
    });

    // Vertical markers for the two numbers the sentence quotes.
    var marks = '';
    function mark(minute, label) {
      if (minute == null || minute <= 0 || minute >= minutes.length) return;
      var mx = x(minute).toFixed(1);
      marks += '<line x1="' + mx + '" y1="' + TOP + '" x2="' + mx + '" y2="' + BASE +
        '" stroke="rgba(56,189,248,0.55)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<circle cx="' + mx + '" cy="' + y(minutes[minute]).toFixed(1) + '" r="3" ' +
        'fill="#0b1220" stroke="#38bdf8" stroke-width="1.5"/>' +
        '<text x="' + clamp(Number(mx), 14, W - 14) + '" y="' + (TOP - 3) +
        '" fill="#7dd3fc" font-size="9" text-anchor="middle">' + esc(label) + '</text>';
    }
    mark(nc.startsIn, 'starts');
    mark(nc.stopsIn, nc.raining ? 'stops' : 'ends');

    var ticks = '';
    [[0, 'Now'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [59, '60 min']].forEach(function (t) {
      var tx = clamp(x(t[0]), 16, W - 18);
      ticks += '<text x="' + tx.toFixed(1) + '" y="' + (H - 3) +
        '" fill="rgba(148,163,184,0.75)" font-size="9" text-anchor="middle">' + t[1] + '</text>';
    });

    var flat = nc.peak <= 0;

    return '' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="w-full h-[116px]" role="img" ' +
      'aria-label="' + esc(nc.summary) + '" preserveAspectRatio="none">' +
        '<defs>' +
          '<linearGradient id="ncFill" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55"/>' +
            '<stop offset="100%" stop-color="#38bdf8" stop-opacity="0.03"/>' +
          '</linearGradient>' +
        '</defs>' +
        guides +
        '<line x1="0" y1="' + BASE + '" x2="' + W + '" y2="' + BASE +
          '" stroke="rgba(148,163,184,0.35)" stroke-width="1"/>' +
        (flat ? '' : '<path d="' + area + '" fill="url(#ncFill)"/>') +
        '<path d="' + line + '" fill="none" stroke="#38bdf8" stroke-width="2" ' +
          'stroke-linejoin="round" stroke-linecap="round"' +
          (state.drawn || flat ? '' : ' class="curve-draw"') + ' vector-effect="non-scaling-stroke"/>' +
        marks + ticks +
      '</svg>';
  }

  // The day timeline: 24 hours of temperature over 24 hours of precipitation
  // chance, scrolling sideways inside its own card.
  function dayTimeline(hours, daily, options) {
    var history = Boolean(options && options.mode === 'history');
    // Forecast bars are a percentage chance; history bars are the millimetres
    // that fell, scaled against the wettest hour of that day.
    var wettest = 0;
    if (history) {
      hours.forEach(function (h) { wettest = Math.max(wettest, h.precip || 0); });
    }
    var barValue = function (h) {
      if (!history) return h.precipProb == null ? 0 : clamp(h.precipProb, 0, 100);
      return wettest > 0 ? clamp(((h.precip || 0) / wettest) * 100, 0, 100) : 0;
    };
    var barLabel = function (h, pct) {
      return history ? depth(h.precip) : Math.round(pct) + '%';
    };
    var COL = 46, H = 168, TOP = 26, TEMP_H = 66, BAR_TOP = 112, BAR_H = 30;
    var W = COL * hours.length;
    var temps = hours.map(function (h) { return h.temp; }).filter(function (v) { return v != null; });
    if (!temps.length) return '';
    var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
    if (hi - lo < 2) { hi = lo + 2; }
    var x = function (i) { return i * COL + COL / 2; };
    var y = function (v) { return TOP + (1 - (v - lo) / (hi - lo)) * TEMP_H; };

    var night = '';
    var line = '';
    var dots = '';
    var labels = '';
    var bars = '';
    var hourLabels = '';

    hours.forEach(function (h, i) {
      if (isNight(h.t, daily)) {
        night += '<rect x="' + (i * COL) + '" y="0" width="' + COL + '" height="' + H +
          '" fill="rgba(15,23,42,0.55)"/>';
      }
      if (h.temp != null) {
        line += (line ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(h.temp).toFixed(1);
        dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(h.temp).toFixed(1) +
          '" r="2.2" fill="#38bdf8"/>';
        if (i % 2 === 0) {
          labels += '<text x="' + x(i).toFixed(1) + '" y="' + (y(h.temp) - 8).toFixed(1) +
            '" fill="#e2e8f0" font-size="11" text-anchor="middle">' + esc(temp(h.temp)) + '</text>';
        }
      }
      var prob = barValue(h);
      var bh = Math.max(prob > 0 ? 2 : 0, (prob / 100) * BAR_H);
      if (bh > 0) {
        bars += '<rect x="' + (i * COL + COL / 2 - 7) + '" y="' + (BAR_TOP + BAR_H - bh).toFixed(1) +
          '" width="14" height="' + bh.toFixed(1) + '" rx="3" fill="#38bdf8" fill-opacity="' +
          (prob >= 50 ? '0.95' : '0.5') + '"/>';
      }
      if (prob >= 30 && i % 2 === 0) {
        labels += '<text x="' + x(i).toFixed(1) + '" y="' + (BAR_TOP + BAR_H - bh - 3).toFixed(1) +
          '" fill="#7dd3fc" font-size="9" text-anchor="middle">' + esc(barLabel(h, prob)) + '</text>';
      }
      hourLabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 4) +
        '" fill="rgba(148,163,184,0.85)" font-size="10" text-anchor="middle">' +
        esc(i === 0 && !history ? 'Now' : fmtHour(h.t)) + '</text>';
    });

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="Temperature and chance of precipitation, hour by hour">' +
      night +
      '<line x1="0" y1="' + (BAR_TOP + BAR_H) + '" x2="' + W + '" y2="' + (BAR_TOP + BAR_H) +
        '" stroke="rgba(148,163,184,0.28)" stroke-width="1"/>' +
      bars +
      '<path d="' + line + '" fill="none" stroke="#38bdf8" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>' +
      dots + labels + hourLabels +
      '</svg>';
  }

  function isNight(t, daily) {
    if (!daily || !daily.length) return false;
    for (var i = 0; i < daily.length; i++) {
      var d = daily[i];
      if (!d.sunrise || !d.sunset) continue;
      // Compare against the sunrise and sunset of the day this hour belongs
      // to, which is the only way to get the shading right near midnight.
      if (t >= d.sunrise - 12 * 3600000 && t < d.sunrise + 12 * 3600000) {
        return t < d.sunrise || t >= d.sunset;
      }
    }
    return false;
  }

  // The week, as temperature range bars on a shared scale so the shape of the
  // week is readable without reading a single number.
  function weekRows(daily) {
    var lows = daily.map(function (d) { return d.tempMin; }).filter(function (v) { return v != null; });
    var highs = daily.map(function (d) { return d.tempMax; }).filter(function (v) { return v != null; });
    if (!lows.length || !highs.length) return '';
    var lo = Math.min.apply(null, lows), hi = Math.max.apply(null, highs);
    var span = Math.max(1, hi - lo);

    return daily.map(function (d, i) {
      var left = d.tempMin == null ? 0 : ((d.tempMin - lo) / span) * 100;
      var width = (d.tempMin == null || d.tempMax == null)
        ? 0 : Math.max(6, ((d.tempMax - d.tempMin) / span) * 100);
      var prob = d.precipProb == null ? 0 : d.precipProb;
      return '' +
        '<div class="flex items-center gap-3 px-4 py-2.5">' +
          '<div class="w-11 shrink-0 text-sm font-medium text-slate-200">' +
            esc(i === 0 ? 'Today' : fmtWeekday(d.t)) + '</div>' +
          '<div class="w-6 shrink-0 text-sky-300">' + icon(d.condition.icon, 'w-5 h-5') + '</div>' +
          '<div class="w-10 shrink-0 text-right text-xs ' +
            (prob >= 30 ? 'text-sky-300' : 'text-slate-600') + '">' +
            (prob >= 5 ? prob + '%' : '') + '</div>' +
          '<div class="w-9 shrink-0 text-right text-sm text-slate-400">' + esc(temp(d.tempMin)) + '</div>' +
          '<div class="flex-1 h-1.5 rounded-full bg-slate-700/60 relative overflow-hidden">' +
            '<div class="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-400 to-amber-300" ' +
              'style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></div>' +
          '</div>' +
          '<div class="w-9 shrink-0 text-sm font-medium text-slate-100">' + esc(temp(d.tempMax)) + '</div>' +
        '</div>';
    }).join('');
  }

  // --------------------------------------------------------------- screens ---

  function header(title, subtitle, right, back) {
    return '' +
      '<header class="sticky top-0 z-20 safe-top pb-2 px-4 bg-slate-950/70 backdrop-blur-xl ' +
        'border-b border-white/5">' +
        '<div class="max-w-md mx-auto flex items-center gap-3">' +
          (back
            ? '<button type="button" data-action="' + back + '" aria-label="Back" ' +
              'class="un-touch-target -ml-1 p-1 rounded-full text-sky-300 hover:text-sky-200">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
              'stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true">' +
              '<path d="M15 5l-7 7 7 7"/></svg></button>'
            : '') +
          '<div class="min-w-0 flex-1">' +
            '<h1 class="text-base font-semibold truncate leading-tight">' + title + '</h1>' +
            (subtitle ? '<p class="text-xs text-slate-400 truncate">' + subtitle + '</p>' : '') +
          '</div>' +
          '<div class="flex items-center gap-1 shrink-0">' + (right || '') + '</div>' +
        '</div>' +
      '</header>';
  }

  function iconButton(action, label, svg, extra) {
    return '<button type="button" data-action="' + action + '" aria-label="' + esc(label) + '" ' +
      'title="' + esc(label) + '" class="un-touch-target p-2 rounded-full text-slate-300 ' +
      'hover:text-sky-300 hover:bg-white/5 ' + (extra || '') + '">' + svg + '</button>';
  }

  var SVG_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>';
  var SVG_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>';
  var SVG_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.6"/><path d="M20 5v6h-6"/></svg>';

  function unitsButton() {
    return '<button type="button" data-action="units" ' +
      'class="un-touch-target px-2.5 py-1.5 rounded-full text-xs font-semibold text-slate-300 ' +
      'hover:text-sky-300 hover:bg-white/5" aria-label="Switch temperature units">°' +
      tempUnit() + '</button>';
  }

  function card(inner, extra, id) {
    return '<section' + (id ? ' id="' + id + '"' : '') +
      ' class="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm ' +
      'overflow-hidden ' + (extra || '') + '">' + inner + '</section>';
  }

  function sectionLabel(text, trailing) {
    return '<div class="flex items-baseline justify-between px-4 pt-3.5 pb-1">' +
      '<h2 class="text-[11px] font-semibold uppercase tracking-widest text-slate-400">' + text + '</h2>' +
      (trailing ? '<span class="text-[11px] text-slate-500">' + trailing + '</span>' : '') + '</div>';
  }

  // ------------------------------------------------------- forecast screen ---

  function forecastScreen() {
    var placeName = state.place ? state.place.name : 'ClearSkies';
    var placeRegion = state.place && state.place.region ? state.place.region : '';

    var right = iconButton('places', 'Saved places', SVG_PIN) +
      iconButton('time-machine', 'Time Machine', SVG_CLOCK) +
      unitsButton();

    var body;
    if (!CAN_CALL_API) body = signInState();
    else if (!state.place) body = emptyState();
    else if (state.status === 'loading') body = skeleton();
    else if (state.status === 'error') body = errorState();
    else body = forecastBody();

    return header(esc(placeName), esc(placeRegion), right) +
      '<main class="max-w-md mx-auto px-4 pt-4 safe-bottom flex flex-col gap-3">' + body + '</main>';
  }

  function emptyState() {
    return card(
      '<div class="p-6 text-center flex flex-col items-center gap-3">' +
        '<div class="text-sky-300">' + icon('partly-cloudy', 'w-12 h-12') + '</div>' +
        '<h2 class="text-lg font-semibold">Pick a place to watch</h2>' +
        '<p class="text-sm text-slate-400 leading-relaxed">ClearSkies tells you when rain starts ' +
          'and stops at one exact point on the map, minute by minute. Choose that point to begin.</p>' +
        '<div class="flex flex-col gap-2 w-full pt-1">' +
          '<button type="button" data-action="locate" class="w-full rounded-xl bg-sky-500 ' +
            'hover:bg-sky-400 text-slate-950 font-semibold py-2.5 text-sm">Use my location</button>' +
          '<button type="button" data-action="places" class="w-full rounded-xl border ' +
            'border-white/10 hover:bg-white/5 text-slate-200 py-2.5 text-sm">Search for a place</button>' +
        '</div>' +
      '</div>');
  }

  function signInState() {
    return card(
      '<div class="p-6 text-center flex flex-col items-center gap-3">' +
        '<div class="text-sky-300">' + icon('partly-cloudy', 'w-12 h-12') + '</div>' +
        '<h2 class="text-lg font-semibold">Open ClearSkies in Usernode</h2>' +
        '<p class="text-sm text-slate-400 leading-relaxed">This page is served through the ' +
          'platform, which signs you in automatically. Opened directly it has no forecast to show.</p>' +
        // A path on this app, not the platform's hostname. target=_top makes
        // it a top-level page load, which server.js redirects to wherever the
        // platform currently lives (USERNODE_PLATFORM_ORIGIN) rather than
        // loading the platform inside this frame. Not `/`: that is served
        // statically before the auth check and would just reload this page.
        '<a href="/open-in-usernode" target="_top" ' +
          'class="rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold ' +
          'px-5 py-2 text-sm">Open in Usernode</a>' +
      '</div>');
  }

  function skeleton() {
    return card('<div class="p-6 animate-pulse flex flex-col gap-3">' +
      '<div class="h-14 w-32 rounded-lg bg-white/10"></div>' +
      '<div class="h-4 w-48 rounded bg-white/10"></div>' +
      '<div class="h-24 w-full rounded-xl bg-white/5"></div></div>');
  }

  function errorState() {
    return card(
      '<div class="p-6 text-center flex flex-col items-center gap-3">' +
        '<div class="text-amber-300">' + icon('fog', 'w-10 h-10') + '</div>' +
        '<h2 class="text-base font-semibold">No forecast right now</h2>' +
        '<p class="text-sm text-slate-400 leading-relaxed">' + esc(state.error || '') + '</p>' +
        '<button type="button" data-action="refresh" class="rounded-xl bg-sky-500 hover:bg-sky-400 ' +
          'text-slate-950 font-semibold px-5 py-2 text-sm">Try again</button>' +
      '</div>');
  }

  function forecastBody() {
    var f = state.forecast;
    var cur = f.current;
    var today = f.daily && f.daily[0];
    var out = '';

    out += alertsBlock();
    out += heroBlock(cur, today);
    out += nowcastBlock(f);
    out += timelineBlock(f);
    out += weekBlock(f);
    out += detailsBlock(cur, today);
    out += sourceBlock(f);
    return out;
  }

  function heroBlock(cur, today) {
    return '<section class="pt-1 pb-1 flex items-start gap-4">' +
      '<div class="flex-1 min-w-0">' +
        '<div id="current-temp" class="text-6xl font-extralight tracking-tighter leading-none">' +
          esc(temp(cur.temp)) + '</div>' +
        '<p class="mt-1.5 text-base text-slate-200">' + esc(cur.condition.label) + '</p>' +
        '<p class="text-sm text-slate-400">Feels like ' + esc(temp(cur.apparentTemp)) +
          (today ? '  &middot;  H ' + esc(temp(today.tempMax)) + '  L ' + esc(temp(today.tempMin)) : '') +
        '</p>' +
      '</div>' +
      '<div class="text-sky-300 shrink-0 pt-1">' + icon(cur.condition.icon, 'w-16 h-16') + '</div>' +
    '</section>';
  }

  // The reason the app exists.
  function nowcastBlock(f) {
    var nc = f.nowcast;
    if (!nc) {
      return card(
        sectionLabel('Next hour') +
        '<p id="nowcast-summary" class="px-4 pb-4 text-sm text-slate-400">' +
          'Minute-by-minute data has not reached this location yet. The hourly forecast below ' +
          'still applies.</p>', 'ring-1 ring-white/5');
    }
    var source = f.nowcastSource === 'pirate-weather'
      ? 'radar' : (f.nowcastSource === 'demo' ? 'demo data' : 'model');
    return card(
      sectionLabel('Next hour', esc(source)) +
      '<p id="nowcast-summary" class="px-4 text-[1.35rem] leading-snug font-medium text-slate-50">' +
        esc(nc.summary) + '</p>' +
      '<div class="px-1 pt-2 pb-1">' + nowcastChart(nc) + '</div>' +
      (nc.peak > 0
        ? '<p class="px-4 pb-3.5 text-xs text-slate-400">Heaviest around ' +
          esc(rate(nc.peak)) + (nc.peakAt > 0 ? ' in ' + nc.peakAt + ' min' : ' now') + '.</p>'
        : '<div class="pb-2"></div>'),
      'ring-1 ring-sky-400/15', 'nowcast-card');
  }

  function timelineBlock(f) {
    var hours = f.hourly.slice(0, 24);
    if (!hours.length) return '';
    return card(
      sectionLabel('Next 24 hours', 'chance of rain') +
      '<div class="scroll-x px-2 pb-2" id="day-timeline">' + dayTimeline(hours, f.daily) + '</div>');
  }

  function weekBlock(f) {
    if (!f.daily || !f.daily.length) return '';
    return card(sectionLabel('7 days') + '<div id="week" class="pb-2">' + weekRows(f.daily) + '</div>');
  }

  function tile(label, value, note) {
    return '<div class="rounded-xl border border-white/10 bg-white/5 px-3.5 py-3">' +
      '<div class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">' + label + '</div>' +
      '<div class="mt-1 text-lg font-medium text-slate-100">' + esc(value) + '</div>' +
      (note ? '<div class="text-xs text-slate-400">' + esc(note) + '</div>' : '') +
      '</div>';
  }

  function detailsBlock(cur, today) {
    var uv = today && today.uvMax != null ? String(Math.round(today.uvMax)) : MISSING;
    return '<div class="grid grid-cols-2 gap-2.5 pt-1">' +
      tile('Feels like', temp(cur.apparentTemp)) +
      tile('Humidity', cur.humidity == null ? MISSING : cur.humidity + '%') +
      tile('Wind', speed(cur.windSpeed), windArrow(cur.windDirection) ? 'from the ' + windArrow(cur.windDirection) : '') +
      tile('Gusts', speed(cur.windGust)) +
      tile('Sunrise', today ? fmtTime(today.sunrise) : MISSING) +
      tile('Sunset', today ? fmtTime(today.sunset) : MISSING) +
      tile('Cloud cover', cur.cloudCover == null ? MISSING : cur.cloudCover + '%') +
      tile('UV index', uv, today && today.uvMax != null ? uvWord(today.uvMax) : '') +
      '</div>';
  }

  function uvWord(uv) {
    if (uv < 3) return 'Low';
    if (uv < 6) return 'Moderate';
    if (uv < 8) return 'High';
    if (uv < 11) return 'Very high';
    return 'Extreme';
  }

  var SEVERITY_CLASS = {
    Extreme: 'border-rose-500/40 bg-rose-500/10',
    Severe: 'border-rose-500/40 bg-rose-500/10',
    Moderate: 'border-amber-500/40 bg-amber-500/10',
    Minor: 'border-sky-500/40 bg-sky-500/10',
    Unknown: 'border-slate-500/40 bg-slate-500/10',
  };

  function alertsBlock() {
    if (!state.alerts || !state.alerts.length) return '';
    return '<div id="alerts" class="flex flex-col gap-2">' + state.alerts.map(function (a) {
      var tone = SEVERITY_CLASS[a.severity] || SEVERITY_CLASS.Unknown;
      var window_ = a.ends ? 'Until ' + fmtTime(a.ends) : '';
      return '<details class="rounded-2xl border ' + tone + ' px-4 py-3">' +
        '<summary class="cursor-pointer list-none flex items-start gap-2.5">' +
          '<span class="mt-0.5 shrink-0 text-current">' + icon('thunderstorm', 'w-4 h-4') + '</span>' +
          '<span class="min-w-0 flex-1">' +
            '<span class="block text-sm font-semibold text-slate-50">' + esc(a.event) + '</span>' +
            '<span class="block text-xs text-slate-300/90">' + esc(window_ || a.severity) + '</span>' +
          '</span>' +
        '</summary>' +
        '<div class="mt-2.5 text-xs leading-relaxed text-slate-300 whitespace-pre-line">' +
          esc(a.description || a.headline || '') +
          (a.instruction ? '\n\n' + esc(a.instruction) : '') +
        '</div>' +
        (a.sender ? '<p class="mt-2 text-[11px] text-slate-500">' + esc(a.sender) + '</p>' : '') +
      '</details>';
    }).join('') + '</div>';
  }

  function sourceBlock(f) {
    var nowcastFrom = f.nowcastSource === 'pirate-weather'
      ? 'Next hour from Pirate Weather radar. '
      : (f.nowcastSource === 'demo' ? 'Showing sample data for the demo. ' : '');
    return '<footer class="pt-2 pb-2 flex items-center justify-between gap-3">' +
      '<p class="text-[11px] leading-relaxed text-slate-500">' +
        esc(nowcastFrom) + (f.demo ? '' : 'Forecast by Open-Meteo. ') +
        'Updated ' + esc(fmtTime(f.fetchedAt)) + '.</p>' +
      iconButton('refresh', 'Refresh', SVG_REFRESH) +
    '</footer>';
  }

  // ---------------------------------------------------------- places screen ---

  function placesScreen() {
    var right = unitsButton();
    var saved = state.places.length
      ? state.places.map(savedRow).join('')
      : '<p class="px-4 py-6 text-center text-sm text-slate-500">No saved places yet. ' +
        'Search above to add one.</p>';

    return header('Places', 'Saved locations', right, 'back') +
      '<main id="places-screen" class="max-w-md mx-auto px-4 pt-4 safe-bottom flex flex-col gap-3">' +
        card(
          '<div class="p-3 flex flex-col gap-2">' +
            '<input id="place-search" type="search" autocomplete="off" ' +
              'placeholder="Search for a town or city" ' +
              'class="w-full rounded-xl bg-slate-900/70 border border-white/10 px-3.5 py-2.5 ' +
              'text-sm text-slate-100 placeholder:text-slate-500 outline-none ' +
              'focus:border-sky-400/60">' +
            '<button type="button" data-action="locate" class="w-full rounded-xl border ' +
              'border-white/10 hover:bg-white/5 text-slate-200 py-2 text-sm">Use my location</button>' +
          '</div>' +
          '<div id="search-results" class="empty:hidden border-t border-white/5"></div>') +
        card(sectionLabel('Saved') + '<div id="saved-list" class="pb-1">' + saved + '</div>') +
      '</main>';
  }

  function savedRow(p) {
    var active = state.place && Math.abs(p.lat - state.place.lat) < 0.001 &&
      Math.abs(p.lon - state.place.lon) < 0.001;
    return '<div class="un-group-row flex items-center gap-2 px-2 py-1" data-place-id="' + p.id + '">' +
      '<span class="drag-handle shrink-0 px-1.5 py-2 text-slate-600 cursor-grab" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" class="w-4 h-4"><path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01"/></svg>' +
      '</span>' +
      '<button type="button" data-action="select-place" data-lat="' + p.lat + '" data-lon="' + p.lon +
        '" data-name="' + esc(p.name) + '" data-region="' + esc(p.region || '') + '" ' +
        'class="flex-1 min-w-0 text-left py-2 pr-2">' +
        '<span class="block text-sm font-medium ' + (active ? 'text-sky-300' : 'text-slate-100') +
          ' truncate">' + esc(p.name) + '</span>' +
        (p.region ? '<span class="block text-xs text-slate-500 truncate">' + esc(p.region) + '</span>' : '') +
      '</button>' +
      '<button type="button" data-action="remove-place" data-id="' + p.id + '" ' +
        'aria-label="Remove ' + esc(p.name) + '" ' +
        'class="un-touch-target shrink-0 p-2 rounded-full text-slate-500 hover:text-rose-300 ' +
        'hover:bg-rose-500/10">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M5 7h14M10 11v6M14 11v6' +
        'M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9.5 7V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/></svg>' +
      '</button>' +
    '</div>';
  }

  function searchResultsHtml(results) {
    if (!results.length) {
      return '<p class="px-4 py-3 text-sm text-slate-500">No matching places. ' +
        'Try a nearby larger town, or use your location above.</p>';
    }
    return results.map(function (r) {
      return '<button type="button" data-action="add-place" data-lat="' + r.lat + '" data-lon="' + r.lon +
        '" data-name="' + esc(r.name) + '" data-region="' + esc(r.region || '') + '" ' +
        'data-timezone="' + esc(r.timezone || '') + '" ' +
        'class="w-full text-left px-4 py-2.5 hover:bg-white/5 border-b border-white/5 last:border-0">' +
        '<span class="block text-sm text-slate-100">' + esc(r.name) + '</span>' +
        (r.region ? '<span class="block text-xs text-slate-500">' + esc(r.region) + '</span>' : '') +
      '</button>';
    }).join('');
  }

  // ----------------------------------------------------- time machine screen ---

  // Open-Meteo's reanalysis archive reaches back to 1940, which is what makes
  // this free rather than a paid add-on.
  var EARLIEST = '1940-01-01';

  function maxDateISO() {
    return new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  }

  function shiftYears(years) {
    var d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - years);
    var iso = d.toISOString().slice(0, 10);
    return iso < EARLIEST ? EARLIEST : iso;
  }

  function timeMachineScreen() {
    var placeName = state.place ? state.place.name : 'Nowhere yet';
    var chips = [
      ['A year ago', shiftYears(1)],
      ['5 years', shiftYears(5)],
      ['10 years', shiftYears(10)],
      ['1980', '1980-' + state.tmDate.slice(5)],
    ].map(function (c) {
      var on = state.tmDate === c[1];
      return '<button type="button" data-action="tm-date" data-date="' + c[1] + '" ' +
        'class="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border ' +
        (on ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
            : 'border-white/10 text-slate-300 hover:bg-white/5') + '">' + c[0] + '</button>';
    }).join('');

    var body;
    if (!state.place) {
      body = card('<p class="p-6 text-center text-sm text-slate-400">Choose a place first, ' +
        'then Time Machine can look up any day it has ever had.</p>');
    } else if (state.tmStatus === 'loading') {
      body = skeleton();
    } else if (state.tmStatus === 'error') {
      body = card('<div class="p-6 text-center flex flex-col items-center gap-3">' +
        '<p class="text-sm text-slate-400">' + esc(state.tmError || '') + '</p>' +
        '<button type="button" data-action="tm-reload" class="rounded-xl bg-sky-500 ' +
        'hover:bg-sky-400 text-slate-950 font-semibold px-5 py-2 text-sm">Try again</button></div>');
    } else if (state.tmData) {
      body = timeMachineResult(state.tmData);
    } else {
      body = '';
    }

    return header('Time Machine', esc(placeName), unitsButton(), 'back') +
      '<main id="time-machine" class="max-w-md mx-auto px-4 pt-4 safe-bottom flex flex-col gap-3">' +
        card('<div class="p-3 flex flex-col gap-2.5">' +
          '<label class="text-[11px] font-semibold uppercase tracking-widest text-slate-400" ' +
            'for="tm-date-input">Any date since 1940</label>' +
          '<input id="tm-date-input" type="date" value="' + esc(state.tmDate) + '" min="' + EARLIEST +
            '" max="' + maxDateISO() + '" class="w-full rounded-xl bg-slate-900/70 border ' +
            'border-white/10 px-3.5 py-2.5 text-sm text-slate-100 outline-none focus:border-sky-400/60">' +
          '<div class="scroll-x flex gap-2 -mx-1 px-1 pt-0.5">' + chips + '</div>' +
        '</div>') +
        body +
      '</main>';
  }

  function timeMachineResult(data) {
    var d = data.day;
    var wet = d.precipSum != null && d.precipSum > 0;
    var hours = (data.hourly || []).filter(function (h) { return h.temp != null; });

    var summary = card(
      '<div id="time-machine-day" class="p-4">' +
        '<p class="text-xs text-slate-400">' + esc(fmtLongDate(Date.parse(data.date + 'T12:00:00Z'))) + '</p>' +
        '<div class="mt-2 flex items-center gap-4">' +
          '<div class="text-sky-300 shrink-0">' + icon(d.condition.icon, 'w-12 h-12') + '</div>' +
          '<div class="min-w-0">' +
            '<div class="text-3xl font-light leading-none">' + esc(temp(d.tempMax)) +
              '<span class="text-slate-500 text-xl"> / ' + esc(temp(d.tempMin)) + '</span></div>' +
            '<p class="mt-1 text-sm text-slate-300">' + esc(d.condition.label) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="mt-3 grid grid-cols-3 gap-2 text-center">' +
          miniStat('Average', temp(d.tempMean)) +
          miniStat(wet ? 'Rainfall' : 'Rainfall', depth(d.precipSum)) +
          miniStat('Peak wind', speed(d.windMax)) +
        '</div>' +
      '</div>');

    var strip = hours.length
      ? card(sectionLabel('Hour by hour', 'rainfall') +
        '<div class="scroll-x px-2 pb-2">' +
        dayTimeline(hours, [{ sunrise: d.sunrise, sunset: d.sunset }], { mode: 'history' }) +
        '</div>')
      : '';

    var provenance = data.source === 'archive'
      ? 'From the ERA5 reanalysis archive via Open-Meteo.'
      : (data.source === 'demo' ? 'Sample data for the demo.' : 'From recent Open-Meteo records.');

    return summary + strip +
      '<p class="px-1 text-[11px] text-slate-500">' + esc(provenance) + '</p>';
  }

  function miniStat(label, value) {
    return '<div class="rounded-xl bg-white/5 border border-white/10 px-2 py-2">' +
      '<div class="text-[10px] uppercase tracking-widest text-slate-500">' + label + '</div>' +
      '<div class="text-sm font-medium text-slate-100 mt-0.5">' + esc(value) + '</div></div>';
  }

  // ------------------------------------------------------------------ render ---

  function render() {
    var root = el('app');
    if (!root) return;
    var html;
    if (state.view === 'places') html = placesScreen();
    else if (state.view === 'time-machine') html = timeMachineScreen();
    else html = forecastScreen();

    root.innerHTML = html +
      '<div id="fallback-toast" class="hidden fixed left-1/2 -translate-x-1/2 bottom-6 z-50 ' +
      'rounded-full bg-slate-800 text-slate-100 text-sm px-4 py-2 shadow-lg"></div>';

    if (state.view === 'forecast' && state.forecast && state.forecast.nowcast) state.drawn = true;
    afterRender();
  }

  function afterRender() {
    if (state.view === 'places') {
      var search = el('place-search');
      if (search) {
        search.addEventListener('input', onSearchInput);
        if (searchTerm) { search.value = searchTerm; }
      }
      attachReorder();
    }
    if (state.view === 'time-machine') {
      var input = el('tm-date-input');
      if (input) {
        input.addEventListener('change', function () {
          if (input.value) selectDate(input.value);
        });
      }
    }
  }

  // Drag-to-reorder is the native idiom for a list like this, so use the kit
  // where it is available. Without it the list still works, it just cannot be
  // dragged.
  function attachReorder() {
    var k = kit();
    var list = el('saved-list');
    if (!k || !k.attachReorder || !list || !state.places.length) return;
    try {
      k.attachReorder(list, {
        handle: '.drag-handle',
        itemSelector: '[data-place-id]',
        onReorder: function () {
          var ids = Array.prototype.slice
            .call(list.querySelectorAll('[data-place-id]'))
            .map(function (n) { return Number(n.getAttribute('data-place-id')); })
            .filter(function (n) { return Number.isInteger(n) && n > 0; });
          if (!ids.length || DEMO) return;
          request('/api/places/order', { method: 'POST', body: { ids: ids } })
            .then(function () {
              state.places.sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
            })
            .catch(function () { toast('That new order could not be saved.'); });
        },
      });
    } catch (e) { /* the list is still usable without dragging */ }
  }

  // ------------------------------------------------------------------ actions ---

  var searchTerm = '';
  var searchTimer = null;

  function onSearchInput(event) {
    searchTerm = event.target.value;
    window.clearTimeout(searchTimer);
    var term = searchTerm.trim();
    var results = el('search-results');
    if (!results) return;
    if (term.length < 2) { results.innerHTML = ''; return; }
    // Debounced so a typed word is one lookup rather than one per keystroke.
    searchTimer = window.setTimeout(function () {
      request(API + '/geocode?q=' + encodeURIComponent(term))
        .then(function (data) {
          if (searchTerm.trim() !== term) return;   // a newer query won
          results.innerHTML = searchResultsHtml(data.results || []);
        })
        .catch(function (err) {
          results.innerHTML = '<p class="px-4 py-3 text-sm text-slate-500">' +
            esc(friendlyError(err)) + '</p>';
        });
    }, 280);
  }

  function setPlace(place, options) {
    state.place = place;
    writeStore('place', JSON.stringify(place));
    state.drawn = false;
    if (!options || options.navigate !== false) state.view = 'forecast';
    syncUrl();
    render();
    loadForecast();
  }

  function addPlace(place) {
    if (DEMO) { setPlace(place); return; }
    request('/api/places', { method: 'POST', body: place })
      .then(function (data) {
        var existing = state.places.filter(function (p) { return p.id !== data.place.id; });
        state.places = existing.concat([data.place])
          .sort(function (a, b) { return a.position - b.position; });
        toast('Saved ' + data.place.name + '.');
        setPlace(place);
      })
      .catch(function (err) { toast(friendlyError(err)); });
  }

  function removePlace(id) {
    if (DEMO) { toast('The demo list cannot be edited.'); return; }
    var previous = state.places;
    state.places = state.places.filter(function (p) { return p.id !== id; });
    render();
    request('/api/places/' + id, { method: 'DELETE' })
      .catch(function (err) {
        state.places = previous;
        render();
        toast(friendlyError(err));
      });
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      toast('This browser cannot share a location.');
      return;
    }
    toast('Finding your location.');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        setPlace({
          name: 'Current location',
          region: '',
          lat: Number(pos.coords.latitude.toFixed(4)),
          lon: Number(pos.coords.longitude.toFixed(4)),
        });
      },
      function () {
        // A denied or unavailable location is an ordinary outcome here, not
        // an error worth logging: the search field is right there.
        toast('Location is unavailable. Search for a place instead.');
      },
      { timeout: 10000, maximumAge: 300000 }
    );
  }

  function selectDate(date) {
    state.tmDate = date;
    syncUrl();
    render();
    loadTimeMachine();
  }

  function go(view) {
    state.view = view;
    syncUrl();
    var k = kit();
    var type = view === 'forecast' ? 'pop' : 'push';
    if (k && k.transition) {
      try { k.transition(render, { type: type }); return; } catch (e) { /* fall through */ }
    }
    render();
    if (view === 'time-machine' && !state.tmData && state.place) loadTimeMachine();
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');

    if (action === 'places') { go('places'); return; }
    if (action === 'back') { go('forecast'); return; }
    if (action === 'time-machine') {
      go('time-machine');
      if (!state.tmData && state.place) loadTimeMachine();
      return;
    }
    if (action === 'units') {
      state.units = state.units === 'c' ? 'f' : 'c';
      writeStore('units', state.units);
      syncUrl();
      render();
      return;
    }
    if (action === 'refresh') { loadForecast(true); return; }
    if (action === 'locate') { useMyLocation(); return; }
    if (action === 'tm-reload') { loadTimeMachine(); return; }
    if (action === 'tm-date') { selectDate(target.getAttribute('data-date')); return; }
    if (action === 'select-place' || action === 'add-place') {
      var place = {
        name: target.getAttribute('data-name'),
        region: target.getAttribute('data-region') || '',
        lat: Number(target.getAttribute('data-lat')),
        lon: Number(target.getAttribute('data-lon')),
      };
      var tz = target.getAttribute('data-timezone');
      if (tz) place.timezone = tz;
      if (action === 'add-place') addPlace(place);
      else setPlace(place);
      return;
    }
    if (action === 'remove-place') {
      removePlace(Number(target.getAttribute('data-id')));
      return;
    }
  });

  // ------------------------------------------------------------------ loading ---

  function query(place) {
    return '?lat=' + encodeURIComponent(place.lat) + '&lon=' + encodeURIComponent(place.lon);
  }

  function loadForecast(isRefresh) {
    if (!state.place) { state.status = 'idle'; render(); return; }
    state.status = state.forecast && isRefresh ? state.status : 'loading';
    if (!isRefresh) render();

    var place = state.place;
    request(API + '/forecast' + query(place))
      .then(function (data) {
        if (state.place !== place) return;    // the user moved on
        state.forecast = data;
        state.status = 'ready';
        state.error = null;
        fmtCache = {};                        // the timezone may have changed
        render();
        if (isRefresh) toast('Updated.');
      })
      .catch(function (err) {
        if (state.place !== place) return;
        state.status = 'error';
        state.error = friendlyError(err);
        render();
      });

    // Alerts are a bonus feed and must never hold up or break the forecast.
    request(API + '/alerts' + query(place))
      .then(function (data) {
        if (state.place !== place) return;
        state.alerts = data.alerts || [];
        if (state.alerts.length && state.status === 'ready') render();
      })
      .catch(function () { state.alerts = []; });
  }

  function loadPlaces() {
    return request(API + '/places')
      .then(function (data) { state.places = data.places || []; })
      .catch(function () { state.places = []; });
  }

  function loadTimeMachine() {
    if (!state.place) return;
    state.tmStatus = 'loading';
    render();
    var place = state.place;
    var date = state.tmDate;
    request(API + '/timemachine' + query(place) + '&date=' + encodeURIComponent(date))
      .then(function (data) {
        if (state.tmDate !== date || state.place !== place) return;
        state.tmData = data;
        state.tmStatus = data.hasData ? 'ready' : 'error';
        state.tmError = data.hasData ? null : 'No records for that day at this location.';
        render();
      })
      .catch(function (err) {
        if (state.tmDate !== date || state.place !== place) return;
        state.tmStatus = 'error';
        state.tmError = friendlyError(err);
        render();
      });
  }

  // ------------------------------------------------------------------ routing ---

  // Every screen is reachable by URL, which is what lets a share link land on
  // the right place and lets the platform's checks and screenshots point at
  // the screen a change actually touched.
  function syncUrl() {
    var next = new URLSearchParams();
    if (token) next.set('token', token);
    if (DEMO) next.set('demo', '1');
    if (state.view !== 'forecast') next.set('view', state.view);
    if (state.view === 'time-machine') next.set('date', state.tmDate);
    if (state.place) {
      next.set('lat', String(state.place.lat));
      next.set('lon', String(state.place.lon));
      if (state.place.name) next.set('place', state.place.name);
    }
    if (state.units === 'f') next.set('units', 'f');
    try {
      window.history.replaceState(null, '', window.location.pathname + '?' + next.toString());
    } catch (e) { /* a blocked history API must not stop the app rendering */ }
  }

  function placeFromUrl() {
    var rawLat = params.get('lat');
    var rawLon = params.get('lon');
    if (!rawLat || !rawLon) return null;
    var lat = Number(rawLat);
    var lon = Number(rawLon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return {
      name: params.get('place') || 'Pinned location',
      region: '',
      lat: lat,
      lon: lon,
    };
  }

  function storedPlace() {
    var raw = readStore('place');
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      return (p && isFinite(p.lat) && isFinite(p.lon)) ? p : null;
    } catch (e) { return null; }
  }

  // -------------------------------------------------------------------- boot ---

  function boot() {
    var storedUnits = params.get('units') || readStore('units');
    state.units = storedUnits === 'f' ? 'f' : 'c';

    var view = params.get('view');
    if (view === 'places' || view === 'time-machine') state.view = view;

    var date = params.get('date');
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.tmDate = date;

    state.place = placeFromUrl() || storedPlace();
    state.status = state.place ? 'loading' : 'idle';

    render();

    if (!CAN_CALL_API) return;

    loadPlaces().then(function () {
      // With nothing pinned and nothing remembered, the first saved place is
      // the sensible opening screen.
      if (!state.place && state.places.length) {
        state.place = {
          name: state.places[0].name,
          region: state.places[0].region || '',
          lat: state.places[0].lat,
          lon: state.places[0].lon,
        };
        state.status = 'loading';
        syncUrl();
      }
      render();
      if (state.place) {
        loadForecast();
        if (state.view === 'time-machine') loadTimeMachine();
      }
    });

    attachPullToRefresh();
  }

  function attachPullToRefresh() {
    var k = kit();
    if (!k || !k.attachPullToRefresh) return;
    try {
      k.attachPullToRefresh(window, function () {
        if (!state.place) return Promise.resolve();
        return request(API + '/forecast' + query(state.place))
          .then(function (data) {
            state.forecast = data;
            state.status = 'ready';
            state.error = null;
            render();
          })
          .catch(function () { /* the visible forecast stays put */ });
      }, { content: el('app') });
    } catch (e) { /* refreshing by button still works */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
