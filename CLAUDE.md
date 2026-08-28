# ClearSkies — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Usernode connector calls (`mcp__usernode__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and
the `presses` table bootstrap in `server.js`) — is placeholder content
from the Usernode starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the `presses` table as appropriate,
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About ClearSkies

ClearSkies is a Dark Sky replacement. The product is one sentence:
"Light rain starting in 12 minutes, stopping in 34 minutes," computed
for an exact latitude and longitude rather than the nearest city, with a
minute-by-minute graph of the next hour underneath it. Everything else
on the screen (the day timeline, the week, Time Machine, alerts) is
supporting cast. If a change would make the nowcast less accurate or
less prominent, it is the wrong change.

The second half of the premise is that it cannot be killed, acquired or
made worse, so the data sources are plural and open (Open-Meteo as the
backbone, Pirate Weather as an optional radar upgrade, weather.gov for
alerts) and each degrades to the next rather than taking the app down.
See README.md for the full picture.

## App-specific conventions

- **The nowcast engine (`lib/nowcast.js`) is pure arithmetic and stays
  that way.** No network, no clock reading beyond what is passed in. It
  is the one part of the app covered by unit tests (`npm test`), because
  it is the one part a page load cannot verify. Extend the tests with any
  change to it.
- **Temperatures are stored and passed around in Celsius, wind in km/h,
  precipitation in mm.** Conversion to Fahrenheit, mph and inches happens
  only at the point of display, in `public/app.js`.
- **Every upstream call is allowed to fail.** A provider error returns a
  partial answer or an empty list, never an exception that reaches the
  user as a broken screen. Alerts in particular must never block or break
  the forecast.
- **`?demo=1` serves a fixed synthetic forecast** from `lib/demo.js`
  through the public `/api/demo/*` routes, so the staging preview, the
  automated checks and the voters' screenshots do not depend on a
  third-party API being reachable. Keep it working, keep it free of user
  data, and keep the demo internally consistent (the hero, the timeline
  and the week must not contradict each other).
- **`saved_places` is marked `staging:private`.** It holds the
  coordinates people watch. Do not add a public table with a foreign key
  to it.
- **Tailwind is precompiled**, so every class name must appear as a whole
  literal. Never assemble one from fragments at runtime.
- **The native kit and the bridge are progressive enhancement.** Every
  use of `window.unNative` is guarded, and every control still works when
  the platform host cannot be reached.
