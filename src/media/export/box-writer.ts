// Low-level MP4 box writing primitives. Ported near-verbatim from src/spikes/A-remux/box-writer.ts
// -- pure, dependency-free, no bug to inherit and nothing spike-specific to rework.

export function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}
export function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}
export function i16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n);
  return b;
}
export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
export function i32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
}
export function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(n)));
  return b;
}
export function fourcc(type: string): Uint8Array {
  if (type.length !== 4) throw new Error(`box type must be 4 chars, got '${type}'`);
  return Uint8Array.from(type, (c) => c.charCodeAt(0));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Wraps `content` as a full box: size(4|largesize) + type(4) + content. Uses the 64-bit largesize form automatically when needed. */
export function makeBox(type: string, content: Uint8Array): Uint8Array {
  const normalSize = 8 + content.byteLength;
  if (normalSize <= 0xffffffff) return concatBytes([u32(normalSize), fourcc(type), content]);
  return concatBytes([u32(1), fourcc(type), u64(16 + content.byteLength), content]);
}

/** version(1) + flags(3) header shared by "full boxes". */
export function fullBoxHeader(version: number, flags = 0): Uint8Array {
  return u32(((version & 0xff) << 24) | (flags & 0x00ffffff));
}
