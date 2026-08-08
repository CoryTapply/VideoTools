import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { nextTimelineHeight } from '../state/splitter.ts';
import styles from './Splitter.module.css';

export interface SplitterProps {
  timelineHeight: number;
  onResize: (height: number) => void;
}

export function Splitter({ timelineHeight, onResize }: SplitterProps) {
  const dragStart = useRef<{ y: number; height: number } | null>(null);

  function handlePointerDown(evt: ReactPointerEvent<HTMLDivElement>) {
    dragStart.current = { y: evt.clientY, height: timelineHeight };
    evt.currentTarget.setPointerCapture(evt.pointerId);
  }

  function handlePointerMove(evt: ReactPointerEvent<HTMLDivElement>) {
    if (dragStart.current === null) {
      return;
    }
    const deltaY = evt.clientY - dragStart.current.y;
    onResize(nextTimelineHeight(dragStart.current.height, deltaY, window.innerHeight));
  }

  function handlePointerUp(evt: ReactPointerEvent<HTMLDivElement>) {
    dragStart.current = null;
    evt.currentTarget.releasePointerCapture(evt.pointerId);
  }

  return (
    <div
      className={styles.root}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className={styles.grip} />
    </div>
  );
}
