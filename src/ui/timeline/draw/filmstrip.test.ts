import { describe, expect, it } from 'vitest';
import { color } from '../../tokens.ts';
import { computeCoverCrop, drawFilmstrip, FILMSTRIP_TILE_WIDTH_PX } from './filmstrip.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { DecodedBitmap } from '../../../media/frames/FrameDecoder.ts';

describe('computeCoverCrop', () => {
  it('crops the sides when the source is wider than the box (160x90 into a 120x90 tile)', () => {
    const crop = computeCoverCrop(160, 90, 120, 90);
    // dst aspect (120/90=1.333) < src aspect (160/90=1.778) -- src is wider, crop its sides.
    expect(crop.sh).toBe(90);
    expect(crop.sw).toBeCloseTo(90 * (120 / 90), 6);
    expect(crop.sx).toBeCloseTo((160 - crop.sw) / 2, 6);
    expect(crop.sy).toBe(0);
  });

  it('crops top/bottom when the source is taller than the box', () => {
    const crop = computeCoverCrop(100, 200, 120, 60);
    expect(crop.sw).toBe(100);
    expect(crop.sh).toBeCloseTo(100 / (120 / 60), 6);
    expect(crop.sy).toBeCloseTo((200 - crop.sh) / 2, 6);
    expect(crop.sx).toBe(0);
  });

  it('is a no-op crop when the aspect ratios already match', () => {
    const crop = computeCoverCrop(160, 90, 320, 180);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 160, sh: 90 });
  });

  it('degenerates safely for zero-sized inputs', () => {
    expect(computeCoverCrop(0, 90, 120, 90)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 90 });
    expect(computeCoverCrop(160, 90, 0, 90)).toEqual({ sx: 0, sy: 0, sw: 160, sh: 90 });
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
      calls.push('fill');
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

const FAKE_BITMAP: DecodedBitmap = { width: 160, height: 90, close: () => {} };

describe('drawFilmstrip', () => {
  it('fills unloaded tiles with the empty-tile placeholder and draws loaded ones', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawFilmstrip(ctx, 240, 37, 100, [FAKE_BITMAP, null]);
    expect(calls.filter((c) => c === 'drawImage')).toHaveLength(1);
    expect(calls.some((c) => c.includes(color.bgTileEmpty))).toBe(true);
  });

  it('covers the full width with ceil(width/tileWidth)+1 tiles', () => {
    const { ctx, calls } = makeRecordingCtx();
    const widthPx = FILMSTRIP_TILE_WIDTH_PX * 2 + 10; // needs 3 tiles + 1 overhang = 4
    drawFilmstrip(ctx, widthPx, 0, 60, []);
    const emptyTileFills = calls.filter((c) => c.includes(color.bgTileEmpty) && c.startsWith('fillRect'));
    expect(emptyTileFills).toHaveLength(4);
  });

  it('draws no inter-tile seam when there is only one tile', () => {
    const { ctx, calls } = makeRecordingCtx();
    drawFilmstrip(ctx, 0, 0, 60, [null]); // ceil(0/120)+1 === 1 tile, no seam before it
    expect(calls.some((c) => c.startsWith('moveTo'))).toBe(false);
  });

  it('draws one seam (two lines) per boundary between tiles', () => {
    const { ctx, calls } = makeRecordingCtx();
    const widthPx = FILMSTRIP_TILE_WIDTH_PX * 2; // ceil(2)+1 = 3 tiles -> 2 seams -> 4 lines
    drawFilmstrip(ctx, widthPx, 0, 60, []);
    expect(calls.filter((c) => c.startsWith('moveTo'))).toHaveLength(4);
  });
});
