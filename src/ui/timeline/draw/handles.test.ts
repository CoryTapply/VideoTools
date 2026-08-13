import { describe, expect, it } from 'vitest';
import { color } from '../../tokens.ts';
import { drawHandles } from './handles.ts';
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

describe('drawHandles', () => {
  it('dims the region left of "in" and right of "out"', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 100, outX: 800, heightPx: 236, drag: null }, null);
    expect(calls).toContain(`fillRect(0,0,100,236)@${color.dim}`);
    expect(calls).toContain(`fillRect(800,0,200,236)@${color.dim}`);
  });

  it('draws no dim rect when in/out reach the canvas edges', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 0, outX: 1000, heightPx: 236, drag: null }, null);
    expect(calls.filter((c) => c.includes(color.dim))).toHaveLength(0);
  });

  it('draws no timecode chip while not dragging', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 100, outX: 800, heightPx: 236, drag: null }, '00:01:00:00');
    expect(calls.some((c) => c.startsWith('fillText'))).toBe(false);
  });

  it('draws a timecode chip while dragging, with the label passed through', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 100, outX: 800, heightPx: 236, drag: 'in' }, '00:01:00:00');
    expect(calls.some((c) => c === 'fillText(00:01:00:00,100,39)')).toBe(true);
  });

  it('highlights the dragged handle with accentActive, the idle one with accent', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 100, outX: 800, heightPx: 236, drag: 'out' }, null);
    expect(calls.some((c) => c === `fill@${color.accent}`)).toBe(true);
    expect(calls.some((c) => c === `fill@${color.accentActive}`)).toBe(true);
  });

  it('draws top/bottom selection borders spanning inX to outX', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 100, outX: 800, heightPx: 236, drag: null }, null);
    expect(calls).toContain('moveTo(100,0.75)');
    expect(calls).toContain('lineTo(800,0.75)');
    expect(calls).toContain('moveTo(100,235.25)');
    expect(calls).toContain('lineTo(800,235.25)');
    expect(calls.some((c) => c === `stroke@${color.selectionBorder}`)).toBe(true);
  });

  it('keeps the full handle bar on-canvas when the edge is at x=0 or x=widthPx, never clipping off a rounded corner', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawHandles(ctx, 1000, { inX: 0, outX: 1000, heightPx: 236, drag: null }, null);
    // Bar is 8px wide; centered at x=0 it would start at x=-4 (clipped). Nudged in, it should
    // start exactly at x=0 (left edge on-canvas) and the "out" bar should end exactly at x=1000.
    expect(calls).toContain('moveTo(0,2)');
    expect(calls).toContain('moveTo(992,2)');
  });
});
