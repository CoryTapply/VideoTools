import { describe, expect, it } from 'vitest';
import { nextScreenForLoadOutcome } from './media-session.ts';

describe('nextScreenForLoadOutcome', () => {
  it('routes a successful load to ready', () => {
    expect(nextScreenForLoadOutcome({ ok: true, value: undefined })).toBe('ready');
  });

  it('routes any playback failure to unsupported -- the index is still valid, only preview fails', () => {
    expect(nextScreenForLoadOutcome({ ok: false, error: { kind: 'unsupported-codec', codec: 'hvc1.1.6.L93.B0' } })).toBe('unsupported');
    expect(nextScreenForLoadOutcome({ ok: false, error: { kind: 'no-video-track' } })).toBe('unsupported');
    expect(nextScreenForLoadOutcome({ ok: false, error: { kind: 'load-failed', message: 'boom' } })).toBe('unsupported');
  });
});
