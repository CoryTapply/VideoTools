# Prompt for Claude Code

Copy everything below into Claude Code with `design_handoff_video_trimmer/` available in the repo.

---

Rework the video trimmer's chrome so the preview gets more vertical height. On a wide window the frame is height-limited, so it sits pillarboxed with wide black bars; every 10px of chrome height removed gives the frame about 18px of width. This change reclaims 117px.

Read these first:

- `design_handoff_video_trimmer/floating-chrome-changes.md` — the spec for this task. It supersedes the README's title bar, transport bar, status bar, ruler and keyframe-row sections.
- `design_handoff_video_trimmer/screenshots/01-ready.png` — target with chrome visible.
- `design_handoff_video_trimmer/screenshots/02-chrome-hidden.png` — same view after the 2s idle fade; note the in-frame readout appears as the chrome goes.
- `design_handoff_video_trimmer/README.md` — the full handoff for everything not changing here (tokens, timeline internals, panels, keyboard map).
- `design_handoff_video_trimmer/Video Trimmer.dc.html` — the updated HTML prototype. It uses a streaming component format (`<sc-if>`, `<sc-for>`, `{{ hole }}`, `style-hover`); read it for exact values but do not copy those conventions. The relevant logic is `wake` / `armIdle` / `chromeEnter` / `chromeLeave` in the logic class and the `chromeOpacity`, `chromePE`, `chromeRightPx`, `chromeCenter`, `transportBottom`, `noticeBottom`, `frameReadout` values in `renderVals()`.

Then, in this order:

1. Take the title bar and the transport bar out of the column layout and re-mount them as absolutely-positioned overlays inside the preview area, per sections 1 and 2 of the note. Contents and styling of their children do not change. Confirm the preview area now starts at the top of the window and that the frame grows accordingly.
2. Delete the status bar. Move the keyframe-shift notice chip to the floating position in section 3 and check its popover still opens upward and is fully on-screen. Drop the zoom/thumbs/index readouts from the UI.
3. Merge the keyframe ticks into the ruler per section 4, including the two dependent offsets (drag label, snap flash). Verify at three zoom levels — wide (gradient band), mid (short ticks), tight (full-height ticks) — that ticks read clearly under the time labels and that in/out-coincident ticks are still blue.
4. Implement auto-hide per section 5 using this codebase's existing idle/visibility utility if it has one. Honour `prefers-reduced-motion` by cutting the 180ms fades to an instant swap, not by disabling the hide.
5. Cross-fade the in-frame readout per section 6, and move the export progress overlay to `top:56px`.

Watch for these, which are the parts most likely to break:

- A hidden overlay must not intercept clicks — `pointer-events:none` while faded out. Test by clicking the frame area where the pill sits after it hides.
- The overlays must not extend under the icon rail or a pinned panel; `right` and the pill's centre both depend on rail width plus pinned-panel width.
- The pill's `bottom` and the notice chip's `bottom` are both derived from the live timeline height — drag the splitter through its full `150px`–`55vh` range and confirm neither detaches from the timeline or overlaps it.
- Full-screen `F` mode should still work with the overlays hidden.

When done, show me the ready state at 1440px and at 2560px wide, with chrome visible and after the idle fade, and tell me the measured frame size at each so I can compare against the note's numbers.
