// Byte-level helpers for assembling synthetic ISOBMFF box structures in tests, via
// BufferByteSource -- this is what makes the edge cases in moov/** unit-testable without a
// real MP4 file.

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

export function u64(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

export function i64(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n));
  return b;
}

export function fourcc(type: string): Uint8Array {
  return Uint8Array.from(Array.from(type, (c) => c.charCodeAt(0)));
}

export function ascii(text: string): Uint8Array {
  return fourcc(text);
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

/** version(1) + flags(3), packed as a "full box" header does. */
export function fullBoxHeader(version: number, flags = 0): Uint8Array {
  return u32(((version & 0xff) << 24) | (flags & 0xffffff));
}

/** Wraps `content` (a plain box body, or several parts to concatenate) in a standard 8-byte-header box. */
export function box(type: string, content: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(content) ? concatBytes(content) : content;
  const size = 8 + body.byteLength;
  return concatBytes([u32(size), fourcc(type), body]);
}

/** Wraps `content` in a box using the 64-bit largesize extension (size32 == 1). */
export function largesizeBox(type: string, content: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(content) ? concatBytes(content) : content;
  const size = 16 + body.byteLength;
  return concatBytes([u32(1), fourcc(type), u64(size), body]);
}
