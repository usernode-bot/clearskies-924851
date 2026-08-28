// WMO weather interpretation codes -> a label and an icon name.
//
// Both Open-Meteo endpoints (forecast and archive) report conditions as WMO
// code 4677 values, so this is the one place the app turns a number into
// something a person reads. The icon name is resolved to artwork on the
// client (public/app.js); keep the names in sync with the ICONS map there.

const CODES = {
  0:  ['Clear',                'clear'],
  1:  ['Mainly clear',         'mostly-clear'],
  2:  ['Partly cloudy',        'partly-cloudy'],
  3:  ['Overcast',             'cloudy'],
  45: ['Fog',                  'fog'],
  48: ['Freezing fog',         'fog'],
  51: ['Light drizzle',        'drizzle'],
  53: ['Drizzle',              'drizzle'],
  55: ['Heavy drizzle',        'drizzle'],
  56: ['Freezing drizzle',     'sleet'],
  57: ['Freezing drizzle',     'sleet'],
  61: ['Light rain',           'rain'],
  63: ['Rain',                 'rain'],
  65: ['Heavy rain',           'heavy-rain'],
  66: ['Freezing rain',        'sleet'],
  67: ['Freezing rain',        'sleet'],
  71: ['Light snow',           'snow'],
  73: ['Snow',                 'snow'],
  75: ['Heavy snow',           'snow'],
  77: ['Snow grains',          'snow'],
  80: ['Light showers',        'showers'],
  81: ['Showers',              'showers'],
  82: ['Heavy showers',        'heavy-rain'],
  85: ['Snow showers',         'snow'],
  86: ['Heavy snow showers',   'snow'],
  95: ['Thunderstorm',         'thunderstorm'],
  96: ['Thunderstorm w/ hail', 'thunderstorm'],
  99: ['Thunderstorm w/ hail', 'thunderstorm'],
};

// Codes that mean frozen or mixed precipitation. The nowcast uses these to
// decide whether to say "rain", "snow" or "sleet" when it has no explicit
// snowfall figure to go on.
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const SLEET_CODES = new Set([56, 57, 66, 67]);

function describe(code) {
  const hit = CODES[code];
  if (!hit) return { code: code == null ? null : code, label: 'Unknown', icon: 'cloudy' };
  return { code, label: hit[0], icon: hit[1] };
}

// `isDay` swaps the two icons that have a night variant. Everything else
// looks the same after dark.
function describeAt(code, isDay) {
  const d = describe(code);
  if (!isDay) {
    if (d.icon === 'clear') d.icon = 'clear-night';
    else if (d.icon === 'mostly-clear') d.icon = 'mostly-clear-night';
    else if (d.icon === 'partly-cloudy') d.icon = 'partly-cloudy-night';
  }
  return d;
}

function precipKindForCode(code) {
  if (SNOW_CODES.has(code)) return 'snow';
  if (SLEET_CODES.has(code)) return 'sleet';
  return 'rain';
}

module.exports = { describe, describeAt, precipKindForCode };
