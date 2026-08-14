import { describe, expect, it } from 'vitest';
import { matchShortcut } from './keyboard-map.ts';

function key(
  k: string,
  modifiers: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
) {
  return {
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('matchShortcut', () => {
  it('matches Space and K to play-pause', () => {
    expect(matchShortcut(key(' '))).toBe('play-pause');
    expect(matchShortcut(key('K'))).toBe('play-pause');
  });

  it('matches plain arrows to frame stepping, shift+arrows to second stepping', () => {
    expect(matchShortcut(key('ArrowLeft'))).toBe('step-back-frame');
    expect(matchShortcut(key('ArrowRight'))).toBe('step-forward-frame');
    expect(matchShortcut(key('ArrowLeft', { shiftKey: true }))).toBe('step-back-second');
    expect(matchShortcut(key('ArrowRight', { shiftKey: true }))).toBe('step-forward-second');
  });

  it('matches I/O to set-in/set-out, shift to jump, alt to clear', () => {
    expect(matchShortcut(key('i'))).toBe('set-in');
    expect(matchShortcut(key('o'))).toBe('set-out');
    expect(matchShortcut(key('i', { shiftKey: true }))).toBe('jump-to-in');
    expect(matchShortcut(key('o', { shiftKey: true }))).toBe('jump-to-out');
    expect(matchShortcut(key('i', { altKey: true }))).toBe('clear-in');
    expect(matchShortcut(key('o', { altKey: true }))).toBe('clear-out');
  });

  it('checks modifier chords before the plain map, so Cmd/Ctrl+E never falls through', () => {
    expect(matchShortcut(key('e', { metaKey: true }))).toBe('export');
    expect(matchShortcut(key('e', { ctrlKey: true }))).toBe('export');
    expect(matchShortcut(key('e'))).toBeNull();
  });

  it('matches Cmd/Ctrl+O to open-file, distinct from the plain O (set-out) chord', () => {
    expect(matchShortcut(key('o', { metaKey: true }))).toBe('open-file');
    expect(matchShortcut(key('o', { ctrlKey: true }))).toBe('open-file');
    expect(matchShortcut(key('o'))).toBe('set-out');
  });

  it('matches Cmd/Ctrl+Z to undo, but not with Shift held', () => {
    expect(matchShortcut(key('z', { metaKey: true }))).toBe('undo');
    expect(matchShortcut(key('z', { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('matches Shift+Z to zoom-fit', () => {
    expect(matchShortcut(key('Z', { shiftKey: true }))).toBe('zoom-fit');
  });

  it('matches ? to toggle-shortcuts even with shiftKey true -- how a real browser reports it', () => {
    // '?' is Shift+/ on a US layout: a real KeyboardEvent for it has shiftKey: true. A version of
    // this test that only checked shiftKey: false previously passed while the real shortcut was
    // broken -- see keyboard-map.ts's comment on why '?' is checked before the shift-gated block.
    expect(matchShortcut(key('?', { shiftKey: true }))).toBe('toggle-shortcuts');
    expect(matchShortcut(key('?'))).toBe('toggle-shortcuts');
  });

  it('matches Escape to close', () => {
    expect(matchShortcut(key('Escape'))).toBe('close');
  });

  it('matches M to toggle-mute', () => {
    expect(matchShortcut(key('m'))).toBe('toggle-mute');
  });

  it('matches Shift+ArrowUp/Down to volume-up/down, distinct from the plain arrow-key/keyframe chords', () => {
    expect(matchShortcut(key('ArrowUp', { shiftKey: true }))).toBe('volume-up');
    expect(matchShortcut(key('ArrowDown', { shiftKey: true }))).toBe('volume-down');
    expect(matchShortcut(key('ArrowUp'))).toBe('prev-keyframe');
    expect(matchShortcut(key('ArrowDown'))).toBe('next-keyframe');
  });

  it('returns null for unrecognized chords', () => {
    expect(matchShortcut(key('a'))).toBeNull();
    expect(matchShortcut(key('k', { shiftKey: true }))).toBeNull();
    expect(matchShortcut(key('q', { altKey: true }))).toBeNull();
  });
});
