# ClearSkies

> **Starter template** — this repo was scaffolded by Usernode Social
> Vibecoding. Everything in it is placeholder example code until the
> app's first real feature is built.

The scaffold is a small working demo that proves the plumbing works:

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores button presses in a `presses` table.
- **Live API** — two example routes (`/api/press`,
  `/api/leaderboard`) read and write through a real Express server.
- **Styling** — Tailwind CSS, precompiled by the Dockerfile on every
  deploy, so there is nothing to rebuild by hand.

## Replacing the template

Open the app on Usernode, tap **Improve** in the header, and describe
the app you want in plain English — the template will be replaced with
your real app. You can also run Claude Code against this repo directly;
start with `CLAUDE.md`, which carries the app-specific notes and
points at the platform rules.

Once the real app exists, rewrite this README to describe it.
