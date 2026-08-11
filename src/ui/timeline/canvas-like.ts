// A narrow interface over the CanvasRenderingContext2D methods/properties draw/*.ts actually
// uses. Tests pass a plain recording fake (no jsdom canvas polyfill needed); TimelineController
// wraps a real 2D context via wrapCanvasContext() for production draws. See src/ui/README.md's
// testability-seam pattern (ByteSource, VideoElementLike) -- this is the same idea for canvas.

import type { DecodedBitmap } from '../../media/frames/FrameDecoder.ts';

export interface CanvasLike {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  /** 9-arg crop form (matches CanvasRenderingContext2D's own overload) -- filmstrip tiles crop
   * rather than letterbox, per design/README.md. DecodedBitmap in production is always a real
   * ImageBitmap (see FrameDecoder.ts), and TS accepts it directly against CanvasImageSource. */
  drawImage(image: DecodedBitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

/** Adapts a real CanvasRenderingContext2D to CanvasLike for production use. */
export function wrapCanvasContext(ctx: CanvasRenderingContext2D): CanvasLike {
  return {
    get fillStyle() {
      return ctx.fillStyle as string;
    },
    set fillStyle(value: string) {
      ctx.fillStyle = value;
    },
    get strokeStyle() {
      return ctx.strokeStyle as string;
    },
    set strokeStyle(value: string) {
      ctx.strokeStyle = value;
    },
    get lineWidth() {
      return ctx.lineWidth;
    },
    set lineWidth(value: number) {
      ctx.lineWidth = value;
    },
    get font() {
      return ctx.font;
    },
    set font(value: string) {
      ctx.font = value;
    },
    get textBaseline() {
      return ctx.textBaseline;
    },
    set textBaseline(value: CanvasTextBaseline) {
      ctx.textBaseline = value;
    },
    get textAlign() {
      return ctx.textAlign;
    },
    set textAlign(value: CanvasTextAlign) {
      ctx.textAlign = value;
    },
    get globalAlpha() {
      return ctx.globalAlpha;
    },
    set globalAlpha(value: number) {
      ctx.globalAlpha = value;
    },
    fillRect: (x, y, w, h) => {
      ctx.fillRect(x, y, w, h);
    },
    clearRect: (x, y, w, h) => {
      ctx.clearRect(x, y, w, h);
    },
    beginPath: () => {
      ctx.beginPath();
    },
    moveTo: (x, y) => {
      ctx.moveTo(x, y);
    },
    lineTo: (x, y) => {
      ctx.lineTo(x, y);
    },
    stroke: () => {
      ctx.stroke();
    },
    fill: () => {
      ctx.fill();
    },
    fillText: (text, x, y) => {
      ctx.fillText(text, x, y);
    },
    drawImage: (image, sx, sy, sw, sh, dx, dy, dw, dh) => {
      ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    },
  };
}
