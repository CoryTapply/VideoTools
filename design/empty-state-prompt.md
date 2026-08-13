# Prompt for Claude Code

Copy everything below into Claude Code, with `design_handoff_video_trimmer/` available in the repo (or point the paths at wherever you put it).

---

Update the video trimmer's **empty state** (no file open) to match a revised design. This is a targeted change to one state — do not touch the ready, indexing, exporting, unsupported-codec, or degraded states, and do not restyle shared chrome beyond what is described.

Read these first:

- `design_handoff_video_trimmer/empty-state-changes.md` — the change note. This is the spec for this task; it supersedes the README's empty-state paragraph.
- `design_handoff_video_trimmer/README.md` — the full screen handoff. Context for tokens, layout rows, panel structure, and the other states. Section "Screen: Trimmer" describes the chrome the empty state is subtracting from.
- `design_handoff_video_trimmer/screenshots/08-empty.png` — the target.
- `design_handoff_video_trimmer/Video Trimmer.dc.html` — the HTML design reference. It is a prototype in a streaming component format (`<sc-if>`, `<sc-for>`, `{{ hole }}`, `style-hover`) — read it for exact geometry and colors, but **do not reproduce those conventions**. The empty-state markup is the `<sc-if value="{{ isEmpty }}">` block in the template; the panel skeleton data is `panelData()` in the logic class, in the `if (s.screen === 'empty')` branch.

Then:

1. Find the existing empty state in this codebase and confirm how `screen`/no-file is currently represented before changing anything. Tell me what you found if it does not map cleanly onto the prototype's `screen` state.
2. Implement the five changes in the change note: hide the title bar and status bar; enlarge and rewrite the drop card and add the `Choose file` button with the `⌘O` hint; add the Recent list; replace panel bodies with pulsing skeletons plus the per-panel note line; keep timeline and export interactions inert.
3. Use this codebase's own primitives — button, skeleton/shimmer, list row — wherever they exist, as long as the resulting metrics match the note. If the codebase already has a skeleton component, use it and match the bar heights (7/8/6px), radius 3, colors `#202024` / `#26262A`, and the 1.6s ease-in-out pulse.
4. Wire `Choose file` and `⌘O` to the same file-open path the title bar's Open button uses. Wire Recent rows to it too if a persisted-handle store exists; if not, render the list from whatever recent-file source exists and tell me — do not invent fixture filenames in production code, and do not ship the list empty-but-visible (hide the whole Recent block when there are no entries).
5. Respect `prefers-reduced-motion`: skeletons hold at their mid-opacity value instead of pulsing.

Copy in the change note is final — use the strings verbatim, including the em dash in "Nothing uploads — the file is read from disk in this tab."

When done, show me the empty state at 1440px wide and at a narrow desktop width (~1000px) so I can check the drop card and Recent list track together.
