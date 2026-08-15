import { rowHeight } from '../tokens.ts';
import styles from './TimelineRegion.module.css';
import type { RefCallback, RefObject } from 'react';

// Indexing covers the filmstrip (and, in M2, the waveform) but not the ruler, which now hosts the
// keyframe ticks too -- design/README.md's "Indexing state" note, design/floating-chrome-changes.md's
// keyframe-row merge. Computed from tokens.ts rather than duplicated as a CSS literal, so the two
// stay in sync if the row height ever changes.
const FILMSTRIP_TOP_PX = rowHeight.ruler;

// The START/END chip's hairline must land exactly on the handle bar's top edge -- design/scrub-chip-prompt.md's
// "Attachment" section. draw/handles.ts draws the bar starting at the filmstrip's top (barTopPx,
// passed as FILMSTRIP_TOP_PX below), not the canvas's, so the chip attaches there too. Revisit this
// constant together with draw/handles.ts if that vertical geometry ever changes.
const CHIP_ATTACH_BOTTOM_PX = FILMSTRIP_TOP_PX;

/** A handle's chip DOM refs -- the wrapper (positioned/shown by the controller) and the time text
 * node (its content written by the controller). See state/useTimelineController.ts. */
export interface ChipRefs {
  wrapper: RefObject<HTMLDivElement | null>;
  time: RefObject<HTMLSpanElement | null>;
}

export interface TimelineRegionProps {
  heightPx: number;
  /** True while `screen` is 'indexing' or 'opening' -- see design/README.md's Indexing state. */
  indexing: boolean;
  /** Task 4b's canvas layer stack target -- see state/useTimelineController.ts. Undefined in
   * ui-harness.html, which never opens a real file and so never constructs a controller; the
   * canvas still mounts (so height/layout screenshots stay accurate) but nothing draws onto it.
   * A callback ref, not a RefObject: useTimelineController.ts needs to know when this canvas
   * mounts/unmounts (the fullscreen toggle does both) so it can rebuild the controller against
   * the fresh node. */
  canvasRef?: RefCallback<HTMLCanvasElement>;
  /** START/END chip DOM refs -- undefined in ui-harness.html for the same reason canvasRef is.
   * Position/visibility/text are all written directly by TimelineController every frame, never
   * through React state -- see design/scrub-chip-prompt.md. */
  chipStartRef?: ChipRefs;
  chipEndRef?: ChipRefs;
}

/**
 * Ruler / keyframe row / filmstrip (no waveform row per the M1 default), drawn by
 * state/useTimelineController.ts's TimelineController onto a single canvas -- see
 * design/README.md's "single canvas, not DOM" mandate (862,401 frames on the reference fixture is
 * too many nodes). The indexing-state stripe overlay and the START/END chips stay DOM elements on
 * top of the canvas -- there are at most a handful of them (not one per frame), and the chips
 * specifically need to float above the canvas's own bounds (`.root`'s `overflow: visible`), which
 * a canvas-drawn element can't do.
 */
export function TimelineRegion({ heightPx, indexing, canvasRef, chipStartRef, chipEndRef }: TimelineRegionProps) {
  return (
    <div className={styles.root} style={{ flex: `0 0 ${heightPx.toString()}px`, height: heightPx }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      {indexing && <div className={styles.indexingOverlay} style={{ top: FILMSTRIP_TOP_PX }} />}
      <div ref={chipStartRef?.wrapper} className={styles.chipWrapper} style={{ bottom: `calc(100% - ${CHIP_ATTACH_BOTTOM_PX.toString()}px)` }}>
        <div className={styles.chip}>
          <span className={styles.chipTag}>START</span>
          <span ref={chipStartRef?.time} className={styles.chipTime} />
        </div>
        <div className={styles.hairline} />
      </div>
      <div ref={chipEndRef?.wrapper} className={styles.chipWrapper} style={{ bottom: `calc(100% - ${CHIP_ATTACH_BOTTOM_PX.toString()}px)` }}>
        <div className={styles.chip}>
          <span className={styles.chipTag}>END</span>
          <span ref={chipEndRef?.time} className={styles.chipTime} />
        </div>
        <div className={styles.hairline} />
      </div>
    </div>
  );
}
