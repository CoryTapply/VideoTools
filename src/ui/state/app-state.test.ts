import { describe, expect, it } from 'vitest';
import { appReducer, createInitialAppState } from './app-state.ts';

describe('createInitialAppState', () => {
  it('defaults to the empty screen with V1 + A1 selected', () => {
    const state = createInitialAppState();
    expect(state.screen).toBe('empty');
    expect(state.sel).toEqual({ V1: true, A1: true, A2: false, A3: false, A4: false, A5: false, A6: false });
  });

  it('defaults volume to 0.7, unmuted', () => {
    const state = createInitialAppState();
    expect(state.vol).toBe(0.7);
    expect(state.muted).toBe(false);
  });

  it('accepts overrides for harness use', () => {
    const state = createInitialAppState({ screen: 'unsupported' });
    expect(state.screen).toBe('unsupported');
  });
});

describe('appReducer', () => {
  it('screen/set switches the screen', () => {
    const state = appReducer(createInitialAppState(), { type: 'screen/set', screen: 'ready' });
    expect(state.screen).toBe('ready');
  });

  it('panel/open sets the transient panel', () => {
    const state = appReducer(createInitialAppState(), { type: 'panel/open', panel: 'info' });
    expect(state.panel).toBe('info');
  });

  it('panel/pin docks the panel and clears the transient one', () => {
    let state = createInitialAppState();
    state = appReducer(state, { type: 'panel/open', panel: 'export' });
    state = appReducer(state, { type: 'panel/pin', panel: 'export' });
    expect(state.pinned).toBe('export');
    expect(state.panel).toBeNull();
  });

  it('panel/unpin clears the docked panel', () => {
    let state = createInitialAppState({ pinned: 'queue' });
    state = appReducer(state, { type: 'panel/unpin' });
    expect(state.pinned).toBeNull();
  });

  it('track/toggle flips any track by id -- locking is the UI layer\'s job, not the reducer\'s', () => {
    let state = appReducer(createInitialAppState(), { type: 'track/toggle', track: 'A2' });
    expect(state.sel.A2).toBe(true);
    state = appReducer(state, { type: 'track/toggle', track: 'V1' });
    expect(state.sel.V1).toBe(false);
  });

  it('sel/set bulk-replaces the whole selection, for a fresh parse\'s default', () => {
    const state = appReducer(createInitialAppState(), { type: 'sel/set', sel: { V1: true, A1: true } });
    expect(state.sel).toEqual({ V1: true, A1: true });
  });

  it('trim-mode/set to exact clears any pending notice', () => {
    const withNotice = createInitialAppState({
      notice: { delta: -4.17, at: 6690, which: 'in' },
      noticeOpen: true,
    });
    const state = appReducer(withNotice, { type: 'trim-mode/set', mode: 'exact' });
    expect(state.trimMode).toBe('exact');
    expect(state.notice).toBeNull();
    expect(state.noticeOpen).toBe(false);
  });

  it('notice/keep-exact switches to exact mode and clears the notice', () => {
    const withNotice = createInitialAppState({
      notice: { delta: -4.17, at: 6690, which: 'in' },
      noticeOpen: true,
      trimMode: 'copy',
    });
    const state = appReducer(withNotice, { type: 'notice/keep-exact' });
    expect(state.trimMode).toBe('exact');
    expect(state.notice).toBeNull();
    expect(state.noticeOpen).toBe(false);
  });

  it('notice/set to null also closes the popover', () => {
    const withNotice = createInitialAppState({
      notice: { delta: -4.17, at: 6690, which: 'in' },
      noticeOpen: true,
    });
    const state = appReducer(withNotice, { type: 'notice/set', notice: null });
    expect(state.noticeOpen).toBe(false);
  });

  it('shortcuts/toggle and full/toggle flip their booleans', () => {
    let state = createInitialAppState();
    state = appReducer(state, { type: 'shortcuts/toggle' });
    expect(state.shortcuts).toBe(true);
    state = appReducer(state, { type: 'full/toggle' });
    expect(state.full).toBe(true);
  });

  it('panel/open and shortcuts/toggle mutually close each other', () => {
    let state = appReducer(createInitialAppState(), { type: 'shortcuts/toggle' });
    expect(state.shortcuts).toBe(true);
    state = appReducer(state, { type: 'panel/open', panel: 'info' });
    expect(state.panel).toBe('info');
    expect(state.shortcuts).toBe(false);
    state = appReducer(state, { type: 'shortcuts/toggle' });
    expect(state.shortcuts).toBe(true);
    expect(state.panel).toBeNull();
  });

  it('timeline-height/set and export/progress store their values', () => {
    let state = createInitialAppState();
    state = appReducer(state, { type: 'timeline-height/set', height: 400 });
    expect(state.timelineH).toBe(400);
    state = appReducer(state, { type: 'export/progress', pct: 42 });
    expect(state.exportPct).toBe(42);
  });

  it('permission-lost/set is independent of screen', () => {
    const state = appReducer(createInitialAppState({ screen: 'ready' }), {
      type: 'permission-lost/set',
      lost: true,
    });
    expect(state.permissionLost).toBe(true);
    expect(state.screen).toBe('ready');
  });

  it('volume/set clamps to 0..1', () => {
    let state = appReducer(createInitialAppState(), { type: 'volume/set', vol: 1.4 });
    expect(state.vol).toBe(1);
    state = appReducer(state, { type: 'volume/set', vol: -0.2 });
    expect(state.vol).toBe(0);
    state = appReducer(state, { type: 'volume/set', vol: 0.42 });
    expect(state.vol).toBe(0.42);
  });

  it('mute/toggle flips muted; mute/set forces a specific value', () => {
    let state = appReducer(createInitialAppState(), { type: 'mute/toggle' });
    expect(state.muted).toBe(true);
    state = appReducer(state, { type: 'mute/toggle' });
    expect(state.muted).toBe(false);
    state = appReducer(state, { type: 'mute/set', muted: true });
    expect(state.muted).toBe(true);
    state = appReducer(state, { type: 'mute/set', muted: true });
    expect(state.muted).toBe(true);
  });

  it('open-error/set stores and clears a parse failure', () => {
    let state = appReducer(createInitialAppState(), { type: 'open-error/set', error: { kind: 'not-isobmff' } });
    expect(state.openError).toEqual({ kind: 'not-isobmff' });
    state = appReducer(state, { type: 'open-error/set', error: null });
    expect(state.openError).toBeNull();
  });
});
