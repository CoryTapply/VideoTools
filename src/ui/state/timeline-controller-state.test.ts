import { describe, expect, it } from 'vitest';
import { createTimelineControllerState } from './timeline-controller-state.ts';

describe('createTimelineControllerState', () => {
  it('defaults to a zeroed, stopped state', () => {
    const state = createTimelineControllerState();
    expect(state).toEqual({
      t: 0,
      viewStart: 0,
      viewSpan: 0,
      playing: false,
      drag: null,
      hover: null,
      dragValueTicks: null,
      barTransition: {
        start: { from: 'rest', to: 'rest', startedAt: -Infinity },
        end: { from: 'rest', to: 'rest', startedAt: -Infinity },
      },
      scrubActive: false,
      panVelocityTicksPerMs: 0,
      snapFlash: null,
      tlW: 0,
    });
  });

  it('accepts overrides', () => {
    const state = createTimelineControllerState({ t: 90000, playing: true });
    expect(state.t).toBe(90000);
    expect(state.playing).toBe(true);
    expect(state.viewSpan).toBe(0);
  });
});
