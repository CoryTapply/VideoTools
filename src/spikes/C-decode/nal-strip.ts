// Spike C -- strips non-VCL (parameter-set / SEI / AUD) NAL units from a length-prefixed
// (AVCC/avc1-style) H.264 sample before handing it to WebCodecs.
//
// Real finding: this project's 27GB OBS fixture's keyframes contain IN-BAND SPS/PPS/SEI NAL
// units ahead of the actual IDR slice (confirmed by manually parsing sample 0's raw bytes: SPS,
// PPS, two SEI, then the 327KB IDR slice, framing byte-exact). That's normal/tolerated for
// Annex-B streams and every real decoder (VLC, ffmpeg, <video>) handles it fine, but it appears
// to trigger a genuine stall in Chrome's WebCodecs VideoDecoder when the decoder was ALREADY
// configured with the same parameter sets via `description` -- decode() neither outputs a frame
// nor calls error() within 10s. Since `description` already carries the parameter sets,
// stripping the redundant in-band copies before decode() is the fix being tested.

const VCL_NAL_TYPE_MIN = 1;
const VCL_NAL_TYPE_MAX = 5;

/** Keeps only VCL (slice, types 1-5) NAL units from a length-prefixed sample; drops SPS/PPS/SEI/AUD/etc. Returns the input unchanged if nothing looked strippable (malformed or no NALs found), rather than risk producing empty/garbage data. */
export function stripNonVclNals(bytes: Uint8Array): { result: Uint8Array; nalTypesSeen: number[]; stripped: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keepRanges: Array<{ start: number; len: number }> = [];
  const nalTypesSeen: number[] = [];
  let pos = 0;
  let anyNonVcl = false;

  while (pos + 4 <= bytes.byteLength) {
    const nalLen = view.getUint32(pos);
    const nalStart = pos + 4;
    if (nalLen === 0 || nalStart + nalLen > bytes.byteLength) break; // malformed/unexpected framing -- bail, fall back to original below
    const nalType = bytes[nalStart]! & 0x1f;
    nalTypesSeen.push(nalType);
    if (nalType >= VCL_NAL_TYPE_MIN && nalType <= VCL_NAL_TYPE_MAX) {
      keepRanges.push({ start: pos, len: 4 + nalLen });
    } else {
      anyNonVcl = true;
    }
    pos = nalStart + nalLen;
  }

  if (keepRanges.length === 0 || pos !== bytes.byteLength) {
    // Either nothing recognizable as a VCL NAL, or the framing didn't cleanly consume the whole
    // sample (unexpected format) -- don't guess, hand back the original bytes untouched.
    return { result: bytes, nalTypesSeen, stripped: false };
  }
  if (!anyNonVcl) {
    return { result: bytes, nalTypesSeen, stripped: false }; // already clean, nothing to do
  }

  let total = 0;
  for (const r of keepRanges) total += r.len;
  const out = new Uint8Array(total);
  let o = 0;
  for (const r of keepRanges) {
    out.set(bytes.subarray(r.start, r.start + r.len), o);
    o += r.len;
  }
  return { result: out, nalTypesSeen, stripped: true };
}
