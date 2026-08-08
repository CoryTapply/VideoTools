# M1 Task 4a — app shell and design system

2-3 days. First UI code in the project — everything before this task was `src/media/*` and the
spike/harness pages under `src/spikes/`.

---

```
Context: browser video trimmer for 20GB+ local files. M1 tasks 1-3 (and 3.5) are
done: src/media/index/ (sample index), src/media/playback/ (NativeVideoEngine,
presentation time is canonical), src/media/frames/ (two-tier frame cache serving
both the filmstrip and drag-scrub preview). None of this task depends on wiring
those in — 4a is presentation only, with placeholder/fixture data standing in for
real media state until later tasks.

This task builds the React shell: layout regions, design tokens, rail and
floating/pinned panels, transport bar, status bar, empty state, splitter. Consume
design/README.md (the authoritative handoff doc) and its linked files in full:
design/original-brief.md, design/revision-request.md (byte-identical to
design/claude-design-revision-request.md — one source, not two), the screenshots in
design/screens/*.png, and design/reference/Video Trimmer.dc.html (read for geometry,
state shape, and interaction logic; its markup format is prototype-only and must not
be ported literally).

Architecture constraints from design/README.md, non-negotiable:
- The timeline is a canvas, built in Task 4b, not this one. This task lays out a
  correctly-sized, splitter-resizable placeholder region for it — no <canvas>, no
  zoom/pan/wheel/drag-scrub logic belongs here.
- React owns the shell, not the playhead. architecture-v3.md's split: ordinary React
  state for discrete/low-frequency UI state, and a separate mutable
  "timeline-controller" object for the 60Hz-mutable fields (t, viewStart, viewSpan,
  drag, ...) that Task 4b's rAF loop will read/write directly, never through React's
  render path. This task only needs to establish that seam (a type + inert factory),
  not implement the controller.
- The preview is a <video> element with a canvas overlay for cached scrub frames —
  not built yet either; 4a's preview surface is a placeholder box.
- No hex literal anywhere outside a single tokens module — including inside future
  canvas draw code, which will import the same module. This is an exit criterion,
  not a suggestion.

Exit criterion (roadmap.md): the shell renders every M1 state with placeholder
content; tokens are the only source of colour in the codebase.

Repo conventions to match (src/media/*): one README.md per module explaining why, not
just what; a barrel with explicit named exports; a testability seam per module (a
narrow interface plus one real implementation and one Node-testable fake); colocated
*.test.ts files. This is a greenfield UI addition — no React, JSX config, or state
library exists in package.json yet; add what's needed (React 19, @vitejs/plugin-react,
jsdom + @testing-library/react for component tests) following the repo's existing
"even browser-only packages go in devDependencies" pattern.
```
