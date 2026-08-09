// Pure chord matching against design/README.md's keyboard map, decoupled from KeyboardEvent via
// a narrow interface -- the same testability-seam pattern as ByteSource/VideoElementLike in
// src/media/. Dispatching the resulting action (stepping a frame, exporting, ...) is the caller's
// job; several of these actions have no real handler yet because the state they'd act on (the
// timeline controller, playback) doesn't exist until later tasks.

export type ShortcutAction =
  | 'play-pause'
  | 'shuttle-back'
  | 'shuttle-forward'
  | 'step-back-frame'
  | 'step-forward-frame'
  | 'step-back-second'
  | 'step-forward-second'
  | 'set-in'
  | 'set-out'
  | 'jump-to-in'
  | 'jump-to-out'
  | 'clear-in'
  | 'clear-out'
  | 'prev-keyframe'
  | 'next-keyframe'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'jump-start'
  | 'jump-end'
  | 'toggle-fullscreen'
  | 'export'
  | 'undo'
  | 'toggle-shortcuts'
  | 'close';

export interface KeyboardEventLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Returns null for chords not in the map, or for a recognized key under an unhandled modifier. */
export function matchShortcut(evt: KeyboardEventLike): ShortcutAction | null {
  const key = evt.key.toLowerCase();
  const mod = evt.ctrlKey || evt.metaKey;

  // Modifier chords are checked before the plain map, per design/README.md, so e.g. Cmd+E never
  // falls through to a plain "e" match.
  if (mod) {
    if (key === 'e') return 'export';
    if (key === 'z' && !evt.shiftKey) return 'undo';
    return null;
  }

  if (evt.altKey) {
    if (key === 'i') return 'clear-in';
    if (key === 'o') return 'clear-out';
    return null;
  }

  // '?' is Shift+/ on a US keyboard layout, so evt.shiftKey is true when it's pressed -- checked
  // here, before the shift-gated block below, so it isn't swallowed by that block's `return null`
  // for every shifted key it doesn't otherwise recognize.
  if (key === '?') return 'toggle-shortcuts';

  if (evt.shiftKey) {
    if (key === 'i') return 'jump-to-in';
    if (key === 'o') return 'jump-to-out';
    if (key === 'z') return 'zoom-fit';
    if (key === 'arrowleft') return 'step-back-second';
    if (key === 'arrowright') return 'step-forward-second';
    return null;
  }

  switch (key) {
    case ' ':
    case 'k':
      return 'play-pause';
    case 'j':
      return 'shuttle-back';
    case 'l':
      return 'shuttle-forward';
    case 'arrowleft':
      return 'step-back-frame';
    case 'arrowright':
      return 'step-forward-frame';
    case 'i':
      return 'set-in';
    case 'o':
      return 'set-out';
    case 'arrowup':
      return 'prev-keyframe';
    case 'arrowdown':
      return 'next-keyframe';
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
      return 'zoom-out';
    case 'home':
      return 'jump-start';
    case 'end':
      return 'jump-end';
    case 'f':
      return 'toggle-fullscreen';
    case 'escape':
      return 'close';
    default:
      return null;
  }
}
