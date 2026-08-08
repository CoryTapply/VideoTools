import { describe, expect, it } from 'vitest';
import {
  formatFrameNumber,
  formatKeyframeShiftMessage,
  formatNoticeDelta,
  formatNoticeLabel,
  formatTimecode,
} from './snap-notice.ts';

describe('formatTimecode', () => {
  it('formats zero as HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 60)).toBe('00:00:00:00');
  });

  it('zero-pads and rolls over at 60fps', () => {
    // 1h 2m 3s and 4 frames at 60fps.
    const frame = (3600 + 2 * 60 + 3) * 60 + 4;
    expect(formatTimecode(frame, 60)).toBe('01:02:03:04');
  });
});

describe('formatFrameNumber', () => {
  it('comma-groups and suffixes with " f"', () => {
    expect(formatFrameNumber(402153)).toBe('402,153 f');
    expect(formatFrameNumber(0)).toBe('0 f');
  });
});

describe('formatNoticeDelta', () => {
  it('uses a minus sign for negative deltas', () => {
    expect(formatNoticeDelta(-4.166)).toBe('−4.17 s');
  });

  it('uses a plus sign for positive deltas', () => {
    expect(formatNoticeDelta(4.166)).toBe('+4.17 s');
  });
});

describe('formatNoticeLabel', () => {
  it('labels in/out moves', () => {
    expect(formatNoticeLabel('in')).toBe('in moved');
    expect(formatNoticeLabel('out')).toBe('out moved');
  });
});

describe('formatKeyframeShiftMessage', () => {
  it('reads "back" for a negative (earlier) delta', () => {
    expect(formatKeyframeShiftMessage('in', -4.17, '01:51:25:52')).toBe(
      'Stream copy can only cut on a keyframe, so the in point moved back to 01:51:25:52.',
    );
  });

  it('reads "forward" for a positive (later) delta', () => {
    expect(formatKeyframeShiftMessage('out', 2.5, '00:10:00:00')).toBe(
      'Stream copy can only cut on a keyframe, so the out point moved forward to 00:10:00:00.',
    );
  });
});
