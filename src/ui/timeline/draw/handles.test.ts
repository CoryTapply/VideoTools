import { describe, expect, it } from 'vitest';
import { color } from '../../tokens.ts';
import { drawHandleBars, drawSelectionOverlay } from './handles.ts';
import type { CanvasLike } from '../canvas-like.ts';

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
    clearRect: () => {},
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
    fillText: (text, x, y) => {
      calls.push(`fillText(${text},${x.toString()},${y.toString()})`);
    },
    drawImage: () => {},
  };
  return { ctx, calls };
}

describe('drawSelectionOverlay', () => {
  it('dims the region left of "start" and right of "end"', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawSelectionOverlay(ctx, 1000, { startX: 100, endX: 800, heightPx: 236, barTopPx: 0, startFill: color.accent, endFill: color.accent });
    expect(calls).toContain(`fillRect(0,0,100,236)@${color.dim}`);
    expect(calls).toContain(`fillRect(800,0,200,236)@${color.dim}`);
  });

  it('draws no dim rect when start/end reach the canvas edges', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawSelectionOverlay(ctx, 1000, { startX: 0, endX: 1000, heightPx: 236, barTopPx: 0, startFill: color.accent, endFill: color.accent });
    expect(calls.filter((c) => c.includes(color.dim))).toHaveLength(0);
  });

  it('draws top/bottom selection borders spanning startX to endX', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawSelectionOverlay(ctx, 1000, { startX: 100, endX: 800, heightPx: 236, barTopPx: 0, startFill: color.accent, endFill: color.accent });
    expect(calls).toContain('moveTo(100,1)');
    expect(calls).toContain('lineTo(800,1)');
    expect(calls).toContain('moveTo(100,235)');
    expect(calls).toContain('lineTo(800,235)');
    expect(calls.some((c) => c === `stroke@${color.selectionBorder}`)).toBe(true);
  });

  it('starts the top selection border at barTopPx, not the canvas top', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawSelectionOverlay(ctx, 1000, { startX: 100, endX: 800, heightPx: 236, barTopPx: 26, startFill: color.accent, endFill: color.accent });
    expect(calls).toContain('fillRect(0,0,100,236)@' + color.dim);
    expect(calls).toContain('moveTo(100,27)');
    expect(calls).toContain('moveTo(100,235)');
    expect(calls).not.toContain('moveTo(100,1)');
  });
});

describe('drawHandleBars', () => {
  it('draws each handle bar with its own passed-in fill color', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandleBars(ctx, 1000, { startX: 100, endX: 800, heightPx: 236, barTopPx: 0, startFill: color.accent, endFill: color.accentActive });
    expect(calls.some((c) => c === `fill@${color.accent}`)).toBe(true);
    expect(calls.some((c) => c === `fill@${color.accentActive}`)).toBe(true);
  });

  it('keeps the full handle bar on-canvas when the edge is at x=0 or x=widthPx, never clipping off a rounded corner', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandleBars(ctx, 1000, { startX: 0, endX: 1000, heightPx: 236, barTopPx: 0, startFill: color.accent, endFill: color.accent });
    // Bar is 8px wide; centered at x=0 it would start at x=-4 (clipped). Nudged in, it should
    // start exactly at x=0 (left edge on-canvas) and the "end" bar should end exactly at x=1000.
    expect(calls).toContain('moveTo(0,2)');
    expect(calls).toContain('moveTo(992,2)');
  });

  it('starts the handle bars at barTopPx, not the canvas top', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandleBars(ctx, 1000, { startX: 100, endX: 800, heightPx: 236, barTopPx: 26, startFill: color.accent, endFill: color.accent });
    expect(calls).toContain('moveTo(96,28)');
    expect(calls).not.toContain('moveTo(96,2)');
  });
});
