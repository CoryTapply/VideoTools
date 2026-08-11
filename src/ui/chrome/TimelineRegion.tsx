import { rowHeight } from '../tokens.ts';
import styles from './TimelineRegion.module.css';
import type { RefObject } from 'react';

// Indexing covers the filmstrip (and, in M2, the waveform) but not the ruler/keyframe rows --
// design/README.md's "Indexing state" note. Computed from tokens.ts rather than duplicated as a
// CSS literal, so the two stay in sync if the row heights ever change.
const FILMSTRIP_TOP_PX = rowHeight.ruler + rowHeight.keyframes;

export interface TimelineRegionProps {
  heightPx: number;
  /** True while `screen` is 'indexing' or 'opening' -- see design/README.md's Indexing state. */
  indexing: boolean;
  /** Task 4b's canvas layer stack target -- see state/useTimelineController.ts. Undefined in
   * ui-harness.html, which never opens a real file and so never constructs a controller; the
   * canvas still mounts (so height/layout screenshots stay accurate) but nothing draws onto it. */
  canvasRef?: RefObject<HTMLCanvasElement | null>;
}

/**
 * Ruler / keyframe row / filmstrip (no waveform row per the M1 default), drawn by
 * state/useTimelineController.ts's TimelineController onto a single canvas -- see
 * design/README.md's "single canvas, not DOM" mandate (862,401 frames on the reference fixture is
 * too many nodes). The indexing-state stripe overlay stays a DOM element on top of the canvas:
 * it's simpler, already correct, and needs no viewport math.
 */
export function TimelineRegion({ heightPx, indexing, canvasRef }: TimelineRegionProps) {
  return (
    <div className={styles.root} style={{ flex: `0 0 ${heightPx.toString()}px`, height: heightPx }}>
      <canvas ref={canvasRef} className={styles.canvas} />
      {indexing && <div className={styles.indexingOverlay} style={{ top: FILMSTRIP_TOP_PX }} />}
    </div>
  );
}
