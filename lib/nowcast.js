// The nowcast: the one feature everybody actually misses.
//
// Turns a precipitation series into (a) a per-minute intensity curve for the
// next hour and (b) the sentence that made Dark Sky worth paying for:
// "Light rain starting in 12 minutes, stopping in 34 minutes."
//
// Two shapes of input, because the app has two providers:
//
//   * Pirate Weather hands us a real radar-derived per-minute array already.
//     `fromMinutes` takes it as-is.
//   * Open-Meteo hands us 15-minute buckets from a high-resolution model.
//     `fromQuarterHours` expands those to per-minute.
//
// Everything below is pure arithmetic over plain numbers, so the whole
// engine is exercised by test/nowcast.test.js without touching the network.

// mm/h below which we call it dry. Radar noise and model drizzle both sit
// under this; without a floor the summary would announce rain that nobody
// outdoors would notice.
const TRACE = 0.08;

// Intensity bands in mm/h, heaviest first. `word` is used mid-sentence, so
// it stays lowercase except where the band name is a proper noun.
const BANDS = [
  { min: 7.6, rain: 'heavy rain',  snow: 'heavy snow',  sleet: 'heavy sleet' },
  { min: 2.5, rain: 'rain',        snow: 'snow',        sleet: 'sleet' },
  { min: 0.5, rain: 'light rain',  snow: 'light snow',  sleet: 'light sleet' },
  { min: TRACE, rain: 'drizzle',   snow: 'flurries',    sleet: 'light sleet' },
];

function bandFor(intensity, kind) {
  for (const b of BANDS) if (intensity >= b.min) return b[kind] || b.rain;
  return null;
}

// A centered moving average, used to turn 15-minute steps into something
// that reads as a curve. The window is deliberately short: a wider one would
// smear the edge of a shower and move the "starting in N minutes" figure,
// which is the number the whole app is judged on.
const SMOOTH_WINDOW = 7;

function smooth(series, window) {
  const half = Math.floor(window / 2);
  const out = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      // Clamp at the edges rather than padding with zeroes, which would
      // fabricate a dry minute at each end of the hour.
      const j = Math.min(series.length - 1, Math.max(0, i + k));
      sum += series[j];
    }
    out[i] = sum / (half * 2 + 1);
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Expand 15-minute accumulation buckets into a 60-minute intensity curve.
//
// `buckets` is [{ endsAt, mm, kind? }] where `mm` fell during the 15 minutes
// ENDING at `endsAt` (Open-Meteo's "preceding 15 minutes sum" convention)
// and `endsAt` is epoch ms. `startAt` is the epoch ms of minute zero.
function fromQuarterHours(buckets, startAt, minutes = 60) {
  const usable = (buckets || []).filter(
    b => b && Number.isFinite(b.endsAt) && Number.isFinite(b.mm)
  );
  if (!usable.length) return null;

  const QUARTER = 15 * 60 * 1000;
  const step = new Array(minutes).fill(0);
  const kinds = new Array(minutes).fill(null);
  let covered = 0;

  for (let m = 0; m < minutes; m++) {
    const t = startAt + m * 60 * 1000;
    // The bucket covering minute m is the one whose interval (endsAt-15m,
    // endsAt] contains it.
    const hit = usable.find(b => t > b.endsAt - QUARTER && t <= b.endsAt);
    if (!hit) continue;
    covered++;
    step[m] = Math.max(0, hit.mm) * 4; // mm per 15 min -> mm/h
    kinds[m] = hit.kind || null;
  }

  // If the model only reaches part-way into the hour there is nothing to
  // nowcast with. Better to say so than to extrapolate a flat line.
  if (covered < minutes * 0.75) return null;

  return build(smooth(step, SMOOTH_WINDOW).map(round2), kinds);
}

// Take an already per-minute intensity array (Pirate Weather's radar
// nowcast). `entries` is [{ mmPerHour, kind? }], minute zero first.
function fromMinutes(entries, minutes = 60) {
  const usable = (entries || []).slice(0, minutes);
  if (usable.length < minutes) return null;
  const series = usable.map(e => Math.max(0, Number(e && e.mmPerHour) || 0));
  return build(series.map(round2), usable.map(e => (e && e.kind) || null));
}

// Shared tail: read the curve and write the sentence.
function build(series, kinds) {
  const wet = series.map(v => v >= TRACE);

  // The dominant precipitation type across the wet minutes decides the
  // wording. Ties fall back to rain, which is what an unlabelled series is.
  const tally = {};
  for (let i = 0; i < series.length; i++) {
    if (!wet[i] || !kinds[i]) continue;
    tally[kinds[i]] = (tally[kinds[i]] || 0) + 1;
  }
  const kind = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || 'rain';

  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i] > peak) { peak = series[i]; peakAt = i; }
  }

  const startsNow = wet[0];
  let startsIn = null;
  let stopsIn = null;

  if (startsNow) {
    // Already raining: when does it stop?
    const dry = wet.indexOf(false);
    if (dry !== -1) stopsIn = dry;
  } else {
    const onset = wet.indexOf(true);
    if (onset !== -1) {
      startsIn = onset;
      // And does it stop again before the hour is out?
      for (let i = onset; i < wet.length; i++) {
        if (!wet[i]) { stopsIn = i; break; }
      }
    }
  }

  // Name the band by the heaviest minute of the stretch being described,
  // not by the current instant: "light rain" reads wrong for a downpour
  // twenty minutes out.
  const from = startsNow ? 0 : (startsIn == null ? 0 : startsIn);
  const to = stopsIn == null ? series.length : stopsIn;
  let stretchPeak = 0;
  for (let i = from; i < to; i++) stretchPeak = Math.max(stretchPeak, series[i]);
  const word = bandFor(stretchPeak, kind);

  return {
    minutes: series,
    kind,
    raining: startsNow,
    startsIn,
    stopsIn,
    peak,
    peakAt,
    intensity: series[0],
    band: word,
    summary: summarize({ startsNow, startsIn, stopsIn, word, kind }),
    short: shortLabel({ startsNow, startsIn, stopsIn, word, kind }),
  };
}

function mins(n) { return n === 1 ? '1 minute' : n + ' minutes'; }

function sentence(s) { return s.charAt(0).toUpperCase() + s.slice(1) + '.'; }

function summarize({ startsNow, startsIn, stopsIn, word, kind }) {
  const dry = kind === 'snow' ? 'No snow for the next hour'
            : kind === 'sleet' ? 'No sleet for the next hour'
            : 'No rain for the next hour';

  if (startsNow) {
    if (stopsIn == null) return sentence(word + ' for the next hour');
    if (stopsIn === 0) return sentence(dry);
    return sentence(word + ' stopping in ' + mins(stopsIn));
  }
  if (startsIn == null) return sentence(dry);
  if (stopsIn == null) return sentence(word + ' starting in ' + mins(startsIn));
  return sentence(word + ' starting in ' + mins(startsIn) + ', stopping in ' + mins(stopsIn));
}

// The one-line version for a collapsed header, where there is no room for
// the full sentence.
function shortLabel({ startsNow, startsIn, stopsIn, word, kind }) {
  if (startsNow) {
    if (stopsIn == null) return cap(word);
    if (stopsIn === 0) return 'Clear';
    return cap(word) + ' for ' + stopsIn + ' min';
  }
  if (startsIn == null) return kind === 'snow' ? 'No snow for an hour' : 'No rain for an hour';
  return cap(word) + ' in ' + startsIn + ' min';
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { fromQuarterHours, fromMinutes, TRACE, BANDS, __test: { smooth, build } };
