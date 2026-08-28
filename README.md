# ClearSkies

A Dark Sky replacement that cannot be bought and switched off.

Dark Sky was shut down after an acquisition, and the thing people actually
miss is very specific: a sentence that tells you **when rain starts and stops
at the exact point you are standing**, and a graph of the next hour you can
read at a glance without interpreting anything.

ClearSkies rebuilds that, on open data, governed by the group that uses it.

## What it does

- **The nowcast.** "Light rain starting in 12 minutes, stopping in 34
  minutes." Computed for one latitude and longitude, not for the nearest
  city.
- **The next-hour graph.** A minute-by-minute intensity curve with the onset
  and the let-up marked on it, plus light / moderate / heavy guides.
- **The day timeline.** Twenty-four hours of temperature over chance of rain,
  scrolling sideways.
- **Seven days**, as temperature range bars on a shared scale.
- **Time Machine.** The weather at any saved place on any date back to 1940.
- **Government alerts** where they are published (United States).
- **Saved places**, reorderable, with the forecast one tap away.

No ads, no upsell, no account to make.

## Where the data comes from

The point is that no single supplier can end the app, so the sources are
plural and each one degrades to the next.

| Source | Used for | Key needed |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com) | The backbone: current conditions, 15 minute precipitation, hourly, 7 day, and the 1940 archive behind Time Machine | None |
| [Pirate Weather](https://pirateweather.net) | Optional upgrade: replaces the next hour with a radar-derived minutely series | `PIRATE_WEATHER_API_KEY` |
| [weather.gov](https://www.weather.gov/documentation/services-web-api) | Active alerts, United States only | None |

Losing the optional key costs accuracy in the next hour and nothing else.
Losing the alert feed costs the alert card and nothing else. Neither can take
the forecast down.

### The optional radar key

Set `PIRATE_WEATHER_API_KEY` in the app's Secrets panel to switch the nowcast
from a 15 minute model to actual radar. Keys are free from
[pirateweather.net](https://pirateweather.net). The key is declared in
`dapp.json` as optional and private, so staging never sees it and the app
boots without it.

## How the nowcast is computed

`lib/nowcast.js` is the engine, and it is pure arithmetic over plain numbers
so it can be tested without a network:

- Pirate Weather already returns a per-minute intensity array, so it is used
  as given.
- Open-Meteo returns 15 minute accumulation buckets. Those become a step
  function in mm/h, then a short centred moving average turns the steps into a
  curve. The window is deliberately narrow: a wider one would smear the edge
  of a shower and move the very number the app is judged on.
- Anything under 0.08 mm/h is treated as dry, so radar noise and model
  drizzle do not announce rain nobody would notice.
- The band named in the sentence comes from the heaviest minute of the stretch
  being described, not the current instant, because "light rain" reads wrong
  for a downpour twenty minutes out.

Run the tests with `npm test`.

## Layout

```
lib/nowcast.js      the sentence and the curve
lib/providers.js    upstream calls, caching, graceful failure
lib/wmo.js          weather codes to labels and icons
lib/demo.js         the deterministic ?demo=1 fixture
server.js           routes, schema, shutdown
public/app.js       the whole front end
test/               nowcast unit tests
```

## The `?demo=1` fixture

Every screen accepts `?demo=1`, which serves a fixed synthetic forecast from
`lib/demo.js` instead of calling out to a weather service. It exists so the
staging preview, the automated checks and the before/after screenshots render
the real screens without depending on a third-party API being reachable from
wherever the build worker runs. It contains no user data and touches no
database, which is why those routes are the only public ones.

Try `/?demo=1`, `/?demo=1&view=places` and
`/?demo=1&view=time-machine&date=1998-06-14`.

## Data and privacy

`saved_places` holds the coordinates people watch, which is personal
information beyond a public username, so the table is marked
`staging:private`: staging gets the schema and none of the rows. Nothing else
is stored. Unit preference lives in the browser, not the database.

## Not built yet

- **Push notifications.** The most-missed Dark Sky feature after the nowcast
  itself. It needs a way to reach a person while the app is closed, which is
  a platform capability rather than something this app can add on its own.
- **The radar animation.** Beloved, and cosmetic. RainViewer tiles would do
  it.
