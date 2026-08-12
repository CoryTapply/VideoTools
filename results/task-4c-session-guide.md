# Task 4c: real-hardware session guide

Both halves of M1 Task 4c (`roadmap.md`) need a human at a real keyboard/trackpad in a real,
non-automated Chrome tab — `claude-in-chrome` automation throttles `requestAnimationFrame` almost
to zero, and the committed tiny test fixture never leaves `readyState 0` in a real `<video>`
element, so neither the seek-drift repro nor the pan/shuttle feel-check can be done by an agent.
This is the one session that closes both gaps.

The app now self-instruments so you don't have to eyeball anything — read the console, don't
guess.

## Setup

```
npm run dev
```

Open `http://localhost:5173/app.html` and drag in (or use the Open button for)
`fixtures/mid-1080p.mp4` — real 1080p content, ~2GB, small enough to iterate quickly with. Don't
use `src/media/index/__fixtures__/tiny.mp4` (confirmed broken for this: never finishes loading)
or `fixtures/vfr-screen.mp4` first (VFR is a confound while isolating this specific bug). Escalate
to `fixtures/27gb.mp4` only if nothing shows up on `mid-1080p.mp4` after a real session.

## Part 1 — seek-drift repro

Every settle-seek (drag-scrub, release) now self-reports. Open devtools console before you start.

1. Let the coarse cache warm (watch the filmstrip fill in).
2. Do a normal mix of interaction for several minutes: play, pause, zoom in/out, drag-pan, and
   repeatedly drag-scrub-and-release — especially right after zooming or other dense-tier decode
   activity, since `architecture-v3.md` ties the bug to "heavy decoder activity."
3. Watch for `[seek-drift]` warnings in the console — each one prints the requested vs. landed
   frame number and tick values directly.
4. When done, run `console.table(window.__seekDriftLog)` in the console — this has every
   settle-seek from the session, not just the ones that scrolled past. Copy/save that table (or
   `copy(window.__seekDriftLog)` to grab it as JSON) and report it back.

If nothing ever fires across a real session on both fixtures, that null result is itself the
"written explanation of why it doesn't reproduce" the roadmap's exit criterion allows for — still
worth reporting precisely (how long, what you did, which fixture).

## Part 2 — kinetic-pan / shuttle feel-check

Both constants are live-tunable from the console now — no rebuild needed between tries:

```js
window.__tuning.kineticPan.coastFrictionPerFrame  // default 0.94 -- closer to 1 coasts longer
window.__tuning.kineticPan.velocityEmaAlpha       // default 0.3 -- higher tracks the latest wheel delta more tightly
window.__tuning.shuttle.baseRate                  // default 1 -- J/L starting speed
window.__tuning.shuttle.maxRate                   // default 8 -- J/L cap (doubles each repeated press)
```

Try a spread on `coastFrictionPerFrame` (e.g. 0.90, 0.94, 0.97) between wheel-pan gestures on the
timeline, and a spread on `maxRate` (e.g. 4, 8, 16) while holding J/L. Report back:
- which friction value felt right, and what was wrong with the ones that didn't (stops too
  abruptly / coasts too long / floaty)
- whether the shuttle doubling curve itself (not just the cap) felt right, or whether it should
  ramp faster/slower — `nextShuttleRate` in `src/ui/state/shuttle.ts` is where that curve lives if
  the shape itself needs to change, not just `baseRate`/`maxRate`.

## After the session

Report back the `__seekDriftLog` contents (or confirmation nothing fired) and your preferred
tuning values. That closes Task 4c: either a confirmed drift cause gets fixed, or the non-repro
gets written up; the tuning constants get baked in as defaults; `roadmap.md` gets updated.
