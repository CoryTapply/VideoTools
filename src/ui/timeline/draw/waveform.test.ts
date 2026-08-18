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

/** Parses the `fillRect(x,y,w,h)@color` call recorded at exactly this x into its numeric y/h, for
 * toBeCloseTo comparisons -- BAR_MAX_HEIGHT_PX/BAR_HEIGHT_SCALE's arithmetic doesn't always land
 * on a clean decimal (e.g. 26*0.95's chain produces 0.6500000000000004), so exact-string matching
 * would be fragile floating-point noise, not a real behavior change if it ever drifts by a float
 * epsilon. */
function barRectAt(calls: readonly string[], x: number): { y: number; h: number } {
  const found = calls.find((c) => c.startsWith(`fillRect(${x.toString()},`) && (c.includes(color.waveformAccent) || c.includes(color.waveformOutOfRange)));
  if (found === undefined) throw new Error(`no bar fillRect at x=${x.toString()} recorded`);
  const args = found.slice(found.indexOf('(') + 1, found.indexOf(')')).split(',');
  return { y: Number(args[1]), h: Number(args[3]) };
}

describe('WAVEFORM_TOTAL_HEIGHT', () => {
  it('is the 26px content band plus a 1px border, per design/README.md\'s M1 filmstrip-absorption arithmetic', () => {
    expect(WAVEFORM_HEIGHT).toBe(26);
    expect(WAVEFORM_TOTAL_HEIGHT).toBe(27);
  });
});

describe('waveformBarCount', () => {
  it('is ceil(width / 2), at least 1', () => {
    expect(waveformBarCount(100)).toBe(50);
    expect(waveformBarCount(101)).toBe(51);
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
    const barFills = calls.filter((c) => c.includes(color.waveformAccent) || c.includes(color.waveformOutOfRange));
    expect(barFills).toHaveLength(0);
  });

  it('centers a bar on the row midline, mirrored equally above and below it', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(-1, 1)], () => true);
    // midY = 13. A full-scale bar (see next test) is 24.7px tall -> 12.35px above and below midY,
    // i.e. NOT touching either row edge (top=0.65, bottom=25.35) -- mirrored, not flush to either.
    const { y, h } = barRectAt(calls, 0);
    expect(y + h / 2).toBeCloseTo(13, 5); // the bar's own vertical center sits exactly on midY
  });

  it('clamps a full-scale peak to nearly the full row height', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(-1, 1)], () => true);
    // (3 + 1*(26-3)) * 0.95 = 24.7 -> only a ~1.3px total gap (split above/below) from the row's
    // full 26px height.
    const { y, h } = barRectAt(calls, 0);
    expect(h).toBeCloseTo(24.7, 5);
    expect(y).toBeCloseTo(0.65, 5);
    expect(calls).toContain(`fillRect(0,${y.toString()},1,${h.toString()})@${color.waveformAccent}`);
  });

  it('gives a silent column (min=max=0) the scaled minimum bar height', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(0, 0)], () => true);
    // 3 * 0.95 = 2.85.
    const { y, h } = barRectAt(calls, 0);
    expect(h).toBeCloseTo(2.85, 5);
    expect(y).toBeCloseTo(11.575, 5);
  });

  it('picks the loudest channel across a multi-channel column, not an average', () => {
    const { ctx, calls } = makeRecordingCtx();
    const stereo: PeakColumn = { time: 0, channels: [{ min: -0.1, max: 0.1 }, { min: -1, max: 0.2 }] };
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [stereo], () => true);
    // peak = max(0.1,0.1,1,0.2) = 1 -> same near-full-height bar as the full-scale test above.
    const { h } = barRectAt(calls, 0);
    expect(h).toBeCloseTo(24.7, 5);
  });

  it('normalizes to the loudest visible column, not a fixed absolute amplitude', () => {
    const { ctx, calls } = makeRecordingCtx();
    // Neither column is anywhere near full-scale (max raw amplitude 0.3) -- the loudest one should
    // still reach the same near-full-height bar as a genuine peak=1 column would (previous test),
    // because normalization is relative to what's visible, not to the [-1,1] range itself.
    const loud = col(-0.3, 0.3, 1); // peak 0.3 -> the loudest column in this frame -> normalizedPeak 1
    const quiet = col(-0.15, 0.15, 2); // peak 0.15 -> half of the loudest -> normalizedPeak 0.5
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [loud, quiet], () => true);
    // loud (index 0, x=0): normalizedPeak=1 -> identical height to a raw peak=1 column.
    expect(barRectAt(calls, 0).h).toBeCloseTo(24.7, 5);
    // quiet (index 1, x = 1*BAR_PITCH_PX = 2): normalizedPeak=0.5 -> (3+11.5)*0.95=13.775.
    expect(barRectAt(calls, 2).h).toBeCloseTo(13.775, 5);
  });

  it('falls every bar to the floor, not NaN, when every visible column is exactly silent', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [col(0, 0), col(0, 0, 1)], () => true);
    expect(calls.some((c) => c.includes('NaN'))).toBe(false);
    // Both columns silent -> maxPeak 0 -> both fall to the same scaled minimum (2.85px) as the
    // single-silent-column case above, at x=0 (index 0) and x=2 (index 1, pitch 2px).
    expect(barRectAt(calls, 0).h).toBeCloseTo(2.85, 5);
    expect(barRectAt(calls, 2).h).toBeCloseTo(2.85, 5);
  });

  it('selects waveformAccent inside the accent range and waveformOutOfRange outside it, per column', () => {
    const { ctx, calls } = makeRecordingCtx();
    const inRange = col(-0.5, 0.5, 1);
    const outRange = col(-0.5, 0.5, 2);
    drawWaveform(ctx, 10, 0, WAVEFORM_HEIGHT, [inRange, outRange], (c) => c.time === 1);
    expect(calls.some((c) => c.includes(`@${color.waveformAccent}`) && c.startsWith('fillRect(0,'))).toBe(true);
    expect(calls.some((c) => c.includes(`@${color.waveformOutOfRange}`) && c.startsWith('fillRect(2,'))).toBe(true);
  });
});
