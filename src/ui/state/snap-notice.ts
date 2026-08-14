// Pure formatting shared by the preview overlay, transport bar, and status pill -- timecodes,
// frame numbers, and the keyframe-shift notice copy. No React/DOM import.

const MINUS_SIGN = '−';

/** `HH:MM:SS:FF`, zero-padded, from a frame count and frame rate. */
export function formatTimecode(frame: number, fps: number): string {
  const totalSeconds = Math.floor(frame / fps);
  const ff = Math.floor(frame % fps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = Math.floor(totalSeconds % 60);
  const pad = (n: number, width = 2) => n.toString().padStart(width, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** `HH:MM:SS` duration (no frame component) -- the export panel's `range` row. */
export function formatDurationHMS(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** Human-readable, unit-labeled duration, e.g. "1h 23m 04s" / "23m 04s" / "0m 04s". Minutes
 * always show (even when zero); the hours field is dropped entirely when zero. Seconds show
 * unless `omitZeroSeconds` is set and the seconds component is exactly "00". */
export function formatDurationCompact(
  totalSeconds: number,
  { omitZeroSeconds = false }: { omitZeroSeconds?: boolean } = {},
): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const secondsPart = omitZeroSeconds && ss === 0 ? '' : ` ${pad(ss)}s`;
  return hh > 0
    ? `${hh.toString()}h ${pad(mm)}m${secondsPart}`
    : `${mm.toString()}m${secondsPart}`;
}

/** Comma-grouped frame number with the design doc's ` f` suffix, e.g. "402,153 f". */
export function formatFrameNumber(frame: number): string {
  return `${Math.floor(frame).toLocaleString('en-US')} f`;
}

/** e.g. -4.17 -> "−4.17 s", 4.17 -> "+4.17 s". */
export function formatNoticeDelta(deltaSeconds: number): string {
  const sign = deltaSeconds < 0 ? MINUS_SIGN : '+';
  return `${sign}${Math.abs(deltaSeconds).toFixed(2)} s`;
}

/** e.g. "in moved" / "out moved" -- the status-bar pill's label. */
export function formatNoticeLabel(which: 'in' | 'out'): string {
  return `${which} moved`;
}

/**
 * The popover body text: "Stream copy can only cut on a keyframe, so the in point moved back to
 * HH:MM:SS:FF." Direction is derived from the delta's sign -- negative (earlier) reads "back",
 * positive (later) reads "forward".
 */
export function formatKeyframeShiftMessage(which: 'in' | 'out', deltaSeconds: number, timecode: string): string {
  const direction = deltaSeconds < 0 ? 'back' : 'forward';
  return `Stream copy can only cut on a keyframe, so the ${which} point moved ${direction} to ${timecode}.`;
}
