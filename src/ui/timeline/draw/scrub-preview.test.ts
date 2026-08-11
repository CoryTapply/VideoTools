import { describe, expect, it } from 'vitest';
import { computeContainFit, drawScrubPreview } from './scrub-preview.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { DecodedBitmap } from '../../../media/frames/FrameDecoder.ts';

describe('computeContainFit', () => {
  it('letterboxes top/bottom when the source is narrower than the box (portrait into 16:9)', () => {
    const fit = computeContainFit(90, 160, 320, 180); // src aspect 0.5625 < dst aspect 1.778
    expect(fit.dh).toBe(180);
    expect(fit.dw).toBeCloseTo(180 * (90 / 160), 6);
    expect(fit.dx).toBeCloseTo((320 - fit.dw) / 2, 6);
    expect(fit.dy).toBe(0);
  });

  it('letterboxes left/right when the source is wider than the box', () => {
    const fit = computeContainFit(320, 90, 200, 200); // src aspect 3.56 > dst aspect 1
    expect(fit.dw).toBe(200);
    expect(fit.dh).toBeCloseTo(200 / (320 / 90), 6);
    expect(fit.dy).toBeCloseTo((200 - fit.dh) / 2, 6);
    expect(fit.dx).toBe(0);
  });

  it('is a no-op fit when aspect ratios already match', () => {
    expect(computeContainFit(320, 180, 640, 360)).toEqual({ dx: 0, dy: 0, dw: 640, dh: 360 });
  });
});

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
    fillRect: () => {},
    clearRect: (x, y, w, h) => {
      calls.push(`clearRect(${x.toString()},${y.toString()},${w.toString()},${h.toString()})`);
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    fillText: () => {},
    drawImage: () => {
      calls.push('drawImage');
    },
  };
  return { ctx, calls };
}

describe('drawScrubPreview', () => {
  it('clears without drawing when there is no bitmap yet', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawScrubPreview(ctx, 320, 180, null);
    expect(calls).toEqual(['clearRect(0,0,320,180)']);
  });

  it('clears then draws when a bitmap is available', () => {
    const { ctx, calls } = makeRecordingCtx();
    const bitmap: DecodedBitmap = { width: 160, height: 90, close: () => {} };
    drawScrubPreview(ctx, 320, 180, bitmap);
    expect(calls).toEqual(['clearRect(0,0,320,180)', 'drawImage']);
  });
});
