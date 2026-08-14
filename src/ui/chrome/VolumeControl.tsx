import { useEffect, useRef, useState } from 'react';
import { SpeakerHighIcon, SpeakerLowIcon, SpeakerMutedIcon } from '../icons/index.tsx';
// Reuses panel-timers.ts's Scheduler seam rather than calling setTimeout directly, so a test can
// drive the close delay deterministically -- the same precedent as FloatingPanel/Rail's own hover
// timing, though this control's open-on-hover is immediate and its close delay (250ms, per
// design/volume-slider-prompt.md) differs from PanelTimers' own 220ms, so it manages its own timer
// rather than instantiating that class.
import { realScheduler } from '../state/panel-timers.ts';
import { motion } from '../tokens.ts';
import styles from './VolumeControl.module.css';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Scheduler } from '../state/panel-timers.ts';

/** Icon/readout switch point -- design/volume-slider-prompt.md: "one arc when volume <= 55%". */
const LOW_VOLUME_THRESHOLD = 0.55;

export interface VolumeControlProps {
  vol: number;
  muted: boolean;
  onToggleMute: () => void;
  onUnmute: () => void;
  onSetVolume: (vol: number) => void;
  /** Test-only seam for the popover's leave-to-close delay. */
  scheduler?: Scheduler;
}

export function VolumeControl({ vol, muted, onToggleMute, onUnmute, onSetVolume, scheduler = realScheduler }: VolumeControlProps) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        scheduler.cancel(closeTimerRef.current);
      }
    },
    [scheduler],
  );

  function handleGroupEnter() {
    if (closeTimerRef.current !== null) {
      scheduler.cancel(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  }

  function handleGroupLeave() {
    closeTimerRef.current = scheduler.schedule(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, motion.volumePopoverCloseMs);
  }

  function volumeFromPointer(evt: ReactPointerEvent<HTMLDivElement>): number {
    const rect = evt.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (evt.clientX - rect.left) / rect.width : 0;
    return Math.min(1, Math.max(0, ratio));
  }

  function handlePointerDown(evt: ReactPointerEvent<HTMLDivElement>) {
    evt.currentTarget.setPointerCapture(evt.pointerId);
    if (muted) onUnmute();
    onSetVolume(volumeFromPointer(evt));
  }

  function handlePointerMove(evt: ReactPointerEvent<HTMLDivElement>) {
    if (!evt.currentTarget.hasPointerCapture(evt.pointerId)) return;
    onSetVolume(volumeFromPointer(evt));
  }

  function handlePointerUp(evt: ReactPointerEvent<HTMLDivElement>) {
    evt.currentTarget.releasePointerCapture(evt.pointerId);
  }

  const percent = Math.round(vol * 100);
  const Icon = muted ? SpeakerMutedIcon : vol <= LOW_VOLUME_THRESHOLD ? SpeakerLowIcon : SpeakerHighIcon;

  return (
    <div className={styles.root} onMouseEnter={handleGroupEnter} onMouseLeave={handleGroupLeave}>
      <button
        type="button"
        className={muted ? `${styles.button} ${styles.buttonMuted}` : styles.button}
        title={muted ? 'Unmute (M)' : 'Mute (M)'}
        onClick={onToggleMute}
      >
        <Icon />
      </button>
      {open && (
        <div className={styles.popover}>
          <div className={styles.trackWrap} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
            <div className={styles.track}>
              <div className={muted ? `${styles.fill} ${styles.fillMuted}` : styles.fill} style={{ width: `${percent.toString()}%` }} />
            </div>
            <div className={muted ? `${styles.knob} ${styles.knobMuted}` : styles.knob} style={{ left: `${percent.toString()}%` }} />
          </div>
          <div className={styles.readout}>
            {muted ? <SpeakerMutedIcon className={styles.readoutMutedIcon} /> : <span className={styles.readoutText}>{percent}%</span>}
          </div>
        </div>
      )}
    </div>
  );
}
