// Pure geometry helpers for the floating title bar / transport pill / notice chip introduced by
// design/floating-chrome-changes.md -- kept out of App.tsx so its JSX stays arithmetic-free.

import { rowHeight } from '../tokens.ts';
import type { PanelId } from '../state/app-state.ts';

/** The floating overlays' `right` offset: past the icon rail, plus a pinned panel's width when
 * one is docked, so they never cross into rail/panel territory -- design/floating-chrome-
 * changes.md's "1. Title bar floats over the preview". */
export function railClearancePx(pinned: PanelId | null): number {
  return pinned === null ? rowHeight.railWidth : rowHeight.railWidth + rowHeight.pinnedPanel;
}

/** The transport pill's `bottom`: 14px above the splitter, which sits atop the timeline --
 * design/floating-chrome-changes.md's "2. Transport becomes a floating pill" (19 = 14px gap +
 * rowHeight.splitter). */
export function transportPillBottomPx(timelineHeightPx: number): number {
  return timelineHeightPx + rowHeight.splitter + 14;
}

// NoticeChip reuses transportPillBottomPx directly: by default it sits at the same height as the
// pill (both near the bottom of the video region), since the pill is horizontally centered and the
// chip is right-aligned, so the two don't normally share any horizontal space. On narrow windows,
// where the centered pill can grow wide enough to reach the right-aligned chip,
// NoticeChip.module.css's own media query lifts it clear of the pill instead.
