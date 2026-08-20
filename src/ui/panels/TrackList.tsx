import { CheckIcon } from '../icons/index.tsx';
import styles from './Panel.module.css';
import { MAX_TRACK_VOLUME } from '../state/app-state.ts';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TrackId, TrackSelection, TrackVolume } from '../state/app-state.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface TrackListProps {
  mode: 'source' | 'export';
  tracks: readonly TrackSummary[];
  sel: TrackSelection;
  onToggle?: (id: TrackId) => void;
  /** Per-track preview volume (1 = unity). Only rendered, and only interactive, in export mode
   * for audio-kind tracks -- see app-state.ts's TrackVolume doc comment for the "preview-only"
   * scope this shares with the transport bar's master VolumeControl. */
  trackVol?: TrackVolume;
  onSetTrackVolume?: (id: TrackId, vol: number) => void;
}

// Unity (1x) sits at the slider's midpoint, not its right edge -- MAX_TRACK_VOLUME (200%) is the
// right edge, so a pointer ratio in [0, 1] maps linearly to a volume in [0, MAX_TRACK_VOLUME].
function volumeFromPointer(evt: ReactPointerEvent<HTMLDivElement>): number {
  const rect = evt.currentTarget.getBoundingClientRect();
  const ratio = rect.width > 0 ? (evt.clientX - rect.left) / rect.width : 0;
  return Math.min(1, Math.max(0, ratio)) * MAX_TRACK_VOLUME;
}

export function TrackList({ mode, tracks, sel, onToggle, trackVol, onSetTrackVolume }: TrackListProps) {
  const count =
    mode === 'source'
      ? `${tracks.filter((t) => t.kind === 'video').length.toString()} video · ${tracks
          .filter((t) => t.kind === 'audio')
          .length.toString()} audio`
      : `${tracks.filter((t) => sel[t.id]).length.toString()} of ${tracks.length.toString()} selected`;

  return (
    <div className={styles.trackListWrapper}>
      <div className={styles.trackListHeader}>
        <span className={styles.trackListTitle}>Tracks</span>
        <span className={styles.trackListCount}>{count}</span>
      </div>
      {tracks.map((track) => {
        // The Source panel is read-only: it never shows a checkmark, regardless of selection
        // state -- design/reference/Video Trimmer.dc.html's trackRows('source') forces `on: false`.
        const on = mode === 'export' && sel[track.id];
        const interactive = mode === 'export';

        const checkboxClass = [styles.checkbox, mode === 'export' ? (on ? styles.checkboxOn : styles.checkboxOff) : '']
          .filter(Boolean)
          .join(' ');
        const rowClass = [
          styles.trackRow,
          mode === 'export' && on ? styles.trackRowSelected : '',
          interactive ? styles.trackRowInteractive : styles.trackRowInert,
        ]
          .filter(Boolean)
          .join(' ');
        const nameClass = `${styles.trackName} ${mode === 'export' && !on ? styles.trackNameOff : styles.trackNameOn}`;

        const showVolume = mode === 'export' && track.kind === 'audio' && onSetTrackVolume !== undefined;
        const vol = trackVol?.[track.id] ?? 1;
        const readoutPercent = Math.round(vol * 100);
        // Slider POSITION, not the same as the readout above -- unity (vol=1) sits at the
        // midpoint (50%), MAX_TRACK_VOLUME at the right edge, per volumeFromPointer's inverse.
        const positionPercent = Math.min(100, Math.max(0, (vol / MAX_TRACK_VOLUME) * 100));

        return (
          <div
            key={track.id}
            className={rowClass}
            onClick={interactive && onToggle ? () => { onToggle(track.id); } : undefined}
          >
            <div className={checkboxClass}>{on && <CheckIcon />}</div>
            <span className={`${styles.trackId} ${track.kind === 'video' ? styles.trackIdVideo : styles.trackIdAudio}`}>
              {track.id}
            </span>
            <div className={styles.trackMeta}>
              <span className={nameClass}>{track.name}</span>
              {/* Export mode drops the codec/channels/rate line -- audio rows show the volume
                  slider in its place instead; the Source panel (mode === 'source') is the one
                  place that detail still matters, so it keeps the line. */}
              {mode === 'source' && <span className={styles.trackMetaLine}>{track.meta}</span>}
              {showVolume && (
                <div
                  className={styles.trackVolumeWrap}
                  title={`Volume ${readoutPercent.toString()}%`}
                  onClick={(evt) => {
                    evt.stopPropagation();
                  }}
                  onPointerDown={(evt) => {
                    evt.stopPropagation();
                    evt.currentTarget.setPointerCapture(evt.pointerId);
                    onSetTrackVolume(track.id, volumeFromPointer(evt));
                  }}
                  onPointerMove={(evt) => {
                    if (!evt.currentTarget.hasPointerCapture(evt.pointerId)) return;
                    onSetTrackVolume(track.id, volumeFromPointer(evt));
                  }}
                  onPointerUp={(evt) => {
                    evt.currentTarget.releasePointerCapture(evt.pointerId);
                  }}
                >
                  <div className={styles.trackVolumeTrack}>
                    <div className={styles.trackVolumeFill} style={{ width: `${positionPercent.toString()}%` }} />
                  </div>
                  {/* Unity reference mark -- fixed at the midpoint, per volumeFromPointer's mapping. */}
                  <div className={styles.trackVolumeUnityTick} />
                  <div className={styles.trackVolumeKnob} style={{ left: `${positionPercent.toString()}%` }} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
