import { describe, expect, it } from 'vitest';
import { color } from '../../tokens.ts';
import { drawWaveform, WAVEFORM_HEIGHT, WAVEFORM_TOTAL_HEIGHT, waveformBarCount } from './waveform.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { PeakColumn } from '../../../media/waveform/types.ts';

function makeRecordingCtx(): { ctx: CanvasLike; calls: string[] } {
  const calls: string[] = [];
  const ctx: CanvasLike = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    globalAlpha: 1,
    fillRect: (x, y, w, h) => {
      calls.push(`fillRect(${x.toString()},${y.toString()},${w.toString()},${h.toString()})@${ctx.fillStyle}`);
    },
    clearRect: () => {
      calls.push('clearRect');
    },
    beginPath: () => {
      calls.push('beginPath');
    },
    moveTo: (x, y) => {
      calls.push(`moveTo(${x.toString()},${y.toString()})`);
    },
    lineTo: (x, y) => {
      calls.push(`lineTo(${x.toString()},${y.toString()})`);
    },
    stroke: () => {
      calls.push(`stroke@${ctx.strokeStyle}`);
    },
    fill: () => {
      calls.push(`fill@${ctx.fillStyle}`);
    },
    fillText: (text) => {
      calls.push(`fillText(${text})`);
    },
    drawImage: () => {
      calls.push('drawImage');
    },
  };
  return { ctx, calls };
}

function col(min: number, max: number, time = 0): PeakColumn {
  return { time, channels: [{ min, max }] };
}

describe('WAVEFORM_TOTAL_HEIGHT', () => {
  it('is the 26px content band plus a 1px border, per design/README.md\'s M1 filmstrip-absorption arithmetic', () => {
    expect(WAVEFORM_HEIGHT).toBe(26);
    expect(WAVEFORM_TOTAL_HEIGHT).toBe(27);
  });
});

describe('waveformBarCount', () => {
  it('is ceil(width / 5), at least 1', () => {
    expect(waveformBarCount(100)).toBe(20);
    expect(waveformBarCount(102)).toBe(21);
    expect(waveformBarCount(0)).toBe(1);
  });
});

describe('drawWaveform', () => {
  it('always draws the border-top rule and background fill, even with no columns', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 200, 100, WAVEFORM_HEIGHT, [], () => false);
    expect(calls).toContain('moveTo(0,99.5)');
    expect(calls).toContain('lineTo(200,99.5)');
    expect(calls.some((c) => c.startsWith(`fillRect(0,100,200,${WAVEFORM_HEIGHT.toString()})@${color.bgWaveform}`))).toBe(true);
  });

  it('draws no bar for a null column', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [null], () => true);
    const barFills = calls.filter((c) => c.startsWith('fill@'));
    expect(barFills).toHaveLength(0);
  });

  it('grows bars up from the row bottom edge, not centered -- every bar path starts and closes at bottom (26)', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(-1, 1)], () => true);
    // moveTo starts the path at the row's bottom edge, and the second-to-last lineTo (just before
    // the closing one back to the start) also lands on the bottom edge -- both square corners.
    expect(calls).toContain('moveTo(0,26)');
    expect(calls.filter((c) => c === 'lineTo(2,26)')).toHaveLength(1);
  });

  it('clamps a full-scale peak to the max bar height (scaled by 0.9), anchored at the bottom', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(-1, 1)], () => true);
    // (3 + 1*(20-3)) * 0.9 = 18 -> bar top = 26 - 18 = 8, chamfer radius 1 -> top+r = 9.
    expect(calls).toContain('lineTo(0,9)');
    expect(calls).toContain('lineTo(1,8)');
    expect(calls).toContain(`fill@${color.waveformAccent}`);
  });

  it('gives a silent column (min=max=0) the scaled minimum bar height', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(0, 0)], () => true);
    // 3 * 0.9 = 2.7 -> bar top = 26 - 2.7 = 23.3, top+r = 24.3.
    expect(calls).toContain('lineTo(0,24.3)');
    expect(calls).toContain('lineTo(1,23.3)');
  });

  it('picks the loudest channel across a multi-channel column, not an average', () => {
    const { ctx, calls } = makeRecordingCtx();
    const stereo: PeakColumn = { time: 0, channels: [{ min: -0.1, max: 0.1 }, { min: -1, max: 0.2 }] };
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [stereo], () => true);
    // peak = max(0.1,0.1,1,0.2) = 1 -> same full-scale (18px) bar as the single-channel case above.
    expect(calls).toContain('lineTo(1,8)');
  });

  it('rounds only the top corners -- square at the bottom, chamfered at the top', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(-1, 1)], () => true);
    // No radius offset on the bottom corners: the path touches x=0 and x=2 exactly at y=26.
    expect(calls).toContain('lineTo(0,26)');
    expect(calls).toContain('lineTo(2,26)');
    // The top corners ARE offset by the radius (1px in from each side, 1px down from the true top).
    expect(calls).not.toContain('lineTo(0,8)');
    expect(calls).not.toContain('lineTo(2,8)');
  });

  it('normalizes to the loudest visible column, not a fixed absolute amplitude', () => {
    const { ctx, calls } = makeRecordingCtx();
    // Neither column is anywhere near full-scale (max raw amplitude 0.3) -- the loudest one should
    // still reach the same full bar height as a genuine peak=1 column would (previous test),
    // because normalization is relative to what's visible, not to the [-1,1] range itself.
    const loud = col(-0.3, 0.3, 1); // peak 0.3 -> the loudest column in this frame -> normalizedPeak 1
    const quiet = col(-0.15, 0.15, 2); // peak 0.15 -> half of the loudest -> normalizedPeak 0.5
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [loud, quiet], () => true);
    // loud: normalizedPeak=1 -> (3+17)*0.9=18 -> top=8, top+r=9 -- identical to a raw peak=1 column.
    expect(calls).toContain('lineTo(0,9)');
    expect(calls).toContain('lineTo(1,8)');
    // quiet: normalizedPeak=0.5 -> (3+8.5)*0.9=10.35 -> top=15.65, top+r=16.65.
    expect(calls).toContain('lineTo(5,16.65)');
    expect(calls).toContain('lineTo(6,15.65)');
  });

  it('falls every bar to the floor, not NaN, when every visible column is exactly silent', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(0, 0), col(0, 0, 1)], () => true);
    expect(calls.some((c) => c.includes('NaN'))).toBe(false);
    // Both columns silent -> maxPeak 0 -> both fall to the scaled minimum (2.7px), same as the
    // single-silent-column case above.
    expect(calls.filter((c) => c === 'lineTo(0,24.3)')).toHaveLength(1);
    expect(calls.filter((c) => c === 'lineTo(5,24.3)')).toHaveLength(1);
  });

  it('selects waveformAccent inside the accent range and waveformOutOfRange outside it, per column', () => {
    const { ctx, calls } = makeRecordingCtx();
    const inRange = col(-0.5, 0.5, 1);
    const outRange = col(-0.5, 0.5, 2);
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [inRange, outRange], (c) => c.time === 1);
    expect(calls).toContain(`fill@${color.waveformAccent}`);
    expect(calls).toContain(`fill@${color.waveformOutOfRange}`);
  });
});
