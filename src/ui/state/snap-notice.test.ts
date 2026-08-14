import { describe, expect, it } from 'vitest';
import {
  formatDurationCompact,
  formatDurationHMS,
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

describe('formatDurationHMS', () => {
  it('formats 122 seconds as 00:02:02', () => {
    expect(formatDurationHMS(122)).toBe('00:02:02');
  });

  it('rolls over hours', () => {
    expect(formatDurationHMS(3661)).toBe('01:01:01');
  });
});

describe('formatDurationCompact', () => {
  it('always shows minutes and seconds by default, even when zero', () => {
    expect(formatDurationCompact(0)).toBe('0m 00s');
    expect(formatDurationCompact(120)).toBe('2m 00s');
    expect(formatDurationCompact(3600)).toBe('1h 00m 00s');
  });

  it('omits the seconds field when omitZeroSeconds is set and seconds are zero', () => {
    expect(formatDurationCompact(0, { omitZeroSeconds: true })).toBe('0m');
    expect(formatDurationCompact(120, { omitZeroSeconds: true })).toBe('2m');
    expect(formatDurationCompact(3600, { omitZeroSeconds: true })).toBe('1h 00m');
  });

  it('keeps the seconds field when omitZeroSeconds is set but seconds are non-zero', () => {
    expect(formatDurationCompact(125, { omitZeroSeconds: true })).toBe('2m 05s');
    expect(formatDurationCompact(3661, { omitZeroSeconds: true })).toBe('1h 01m 01s');
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
