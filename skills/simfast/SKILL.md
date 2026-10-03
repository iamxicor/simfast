---
name: simfast
description: Drive the iOS Simulator quickly and cheaply by reading a compact text listing of the screen instead of screenshots. Use whenever you need to tap, type, scroll or navigate in the iOS Simulator, test an iOS app flow, or check what is on an iOS simulator screen.
---

# simfast: iOS Simulator by text, not pixels

`simfast` is a CLI. It keeps a warm daemon per simulator, so each call is ~1 s and returns the NEW screen.

## The loop

1. `simfast see` : compact list, one line per element: `index  Type  label  (x,y)`.
2. Act by **label** (stable) or by index from the latest listing:
   - `simfast tap "General"`      `simfast tap 7`      `simfast tap 120,340`
   - `simfast type "hello" --submit`      `simfast scroll down`      `simfast key return`
3. Every action prints the new screen and whether it **changed**. Do not call `see` or take a screenshot after acting.
4. Know the path? Batch it: `simfast do "tap General" "tap About"`: one call, one screen read at the end, stops at the first failure and shows where.

## Rules

- Prefer labels over indexes. Indexes are only valid for the screen you just saw, and only for the first step of a `do`.
- `screen UNCHANGED` after a tap means it did not do what you expected: re-read the listing before retrying.
- Screenshots are for visual checks only (`simfast shot /tmp/x.png`, then read the image). If the listing looks wrong or
  stale (e.g. it shows the previous page's items), the accessibility tree may be incomplete: take one screenshot.
- Launch apps with `simfast launch <bundle-id>`; open deep links with `simfast open <url>`.
- Several simulators booted? Pass `--udid <udid>` or set `SIMFAST_UDID`.

Run `simfast doctor` if anything is not working.
