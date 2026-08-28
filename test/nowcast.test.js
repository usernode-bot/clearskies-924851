// The nowcast is the feature this app exists for, and it is the one piece
// that cannot be checked by loading a page: the number in "starting in 12
// minutes" comes out of arithmetic, not out of the DOM. These tests pin that
// arithmetic down with hand-built series, so they run with no network and no
// database.
//
//   node --test

const test = require('node:test');
const assert = require('node:assert');
const nowcast = require('../lib/nowcast');

const MIN = 60 * 1000;
const QUARTER = 15 * MIN;

// Build the bucket list Open-Meteo would return: `mm` is the total that fell
// in the 15 minutes ENDING at each timestamp. `now` sits inside the first.
function buckets(now, mmPerBucket) {
  const firstEnd = now + QUARTER;
  return mmPerBucket.map((mm, i) => ({ endsAt: firstEnd + i * QUARTER, mm }));
}

const NOW = Date.UTC(2026, 0, 15, 12, 7, 0);

test('dry hour says so plainly', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [0, 0, 0, 0, 0]), NOW);
  assert.equal(n.summary, 'No rain for the next hour.');
  assert.equal(n.raining, false);
  assert.equal(n.startsIn, null);
  assert.equal(n.peak, 0);
});

test('rain arriving later in the hour is announced with a lead time', () => {
  // Dry through 12:37, then 1.5mm in the quarter ending 12:52.
  const n = nowcast.fromQuarterHours(buckets(NOW, [0, 0, 1.5, 1.5, 0]), NOW);
  assert.equal(n.raining, false);
  assert.ok(n.startsIn > 0 && n.startsIn < 60, 'onset falls inside the hour');
  // 1.5mm/15min is 6mm/h, the "rain" band.
  assert.match(n.summary, /^Rain starting in \d+ minutes\.$/);
});

test('a shower that starts and ends gives the classic two-clause sentence', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [0, 0.3, 0, 0, 0]), NOW);
  assert.equal(n.raining, false);
  assert.ok(n.startsIn != null && n.stopsIn != null);
  assert.ok(n.stopsIn > n.startsIn, 'it stops after it starts');
  assert.match(n.summary, /starting in \d+ minutes?, stopping in \d+ minutes?\.$/);
});

test('rain already falling reports when it stops', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [0.8, 0.8, 0, 0, 0]), NOW);
  assert.equal(n.raining, true);
  assert.ok(n.stopsIn > 0 && n.stopsIn < 60);
  assert.match(n.summary, /stopping in \d+ minutes\.$/);
});

test('rain through the whole hour does not invent a stop time', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [1, 1, 1, 1, 1]), NOW);
  assert.equal(n.raining, true);
  assert.equal(n.stopsIn, null);
  assert.equal(n.summary, 'Rain for the next hour.');
});

test('the band is named for the heaviest minute of the stretch, not the first', () => {
  // A light onset that becomes a downpour still reads as heavy rain.
  const n = nowcast.fromQuarterHours(buckets(NOW, [0, 0.2, 4, 4, 4]), NOW);
  assert.match(n.summary, /^Heavy rain starting in/);
});

test('snow is described as snow', () => {
  const wintry = buckets(NOW, [0, 0, 1.5, 1.5, 1.5]).map(b => ({ ...b, kind: 'snow' }));
  const n = nowcast.fromQuarterHours(wintry, NOW);
  assert.equal(n.kind, 'snow');
  assert.match(n.summary, /snow starting in/i);
});

test('one minute is singular', () => {
  const series = new Array(60).fill(0);
  for (let i = 1; i < 60; i++) series[i] = 3;
  const n = nowcast.__test.build(series, new Array(60).fill(null));
  assert.equal(n.summary, 'Rain starting in 1 minute.');
});

test('a per-minute radar series is used as given', () => {
  const entries = new Array(60).fill(null).map((_, i) => ({ mmPerHour: i < 20 ? 0 : 3 }));
  const n = nowcast.fromMinutes(entries);
  assert.equal(n.startsIn, 20, 'no smoothing is applied to real minutely data');
  assert.equal(n.summary, 'Rain starting in 20 minutes.');
});

test('a short or empty series yields no nowcast rather than a guess', () => {
  assert.equal(nowcast.fromMinutes([{ mmPerHour: 1 }]), null);
  assert.equal(nowcast.fromQuarterHours([], NOW), null);
  // Model coverage that runs out mid-hour is not enough to nowcast with.
  assert.equal(nowcast.fromQuarterHours(buckets(NOW, [0, 1]), NOW), null);
});

test('trace amounts do not count as rain', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [0.01, 0.01, 0.01, 0.01, 0.01]), NOW);
  assert.equal(n.raining, false);
  assert.equal(n.summary, 'No rain for the next hour.');
});

test('the curve is always 60 finite, non-negative minutes', () => {
  const n = nowcast.fromQuarterHours(buckets(NOW, [0, 3, 0, 1, 0]), NOW);
  assert.equal(n.minutes.length, 60);
  assert.ok(n.minutes.every(v => Number.isFinite(v) && v >= 0));
});

test('no user-facing string contains an em dash', () => {
  const cases = [
    nowcast.fromQuarterHours(buckets(NOW, [0, 0, 0, 0, 0]), NOW),
    nowcast.fromQuarterHours(buckets(NOW, [0, 0, 2, 0, 0]), NOW),
    nowcast.fromQuarterHours(buckets(NOW, [1, 1, 1, 1, 1]), NOW),
    nowcast.fromQuarterHours(buckets(NOW, [1, 0, 0, 0, 0]), NOW),
  ];
  for (const c of cases) {
    assert.ok(!/—/.test(c.summary), c.summary);
    assert.ok(!/—/.test(c.short), c.short);
  }
});
