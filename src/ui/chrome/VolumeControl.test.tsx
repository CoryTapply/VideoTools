// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VolumeControl } from './VolumeControl.tsx';
import type { Scheduler } from '../state/panel-timers.ts';

afterEach(cleanup);

/** Deterministic Scheduler double -- same shape as panel-timers.test.ts's own FakeScheduler. */
class FakeScheduler implements Scheduler {
  #nextId = 1;
  #pending = new Map<number, () => void>();

  schedule(fn: () => void): number {
    const id = this.#nextId++;
    this.#pending.set(id, fn);
    return id;
  }

  cancel(id: number): void {
    this.#pending.delete(id);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  runAllPending(): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const fn of entries) fn();
  }
}

const baseProps = {
  vol: 0.7,
  muted: false,
  onToggleMute: () => {},
  onUnmute: () => {},
  onSetVolume: () => {},
};

function group(getByTitle: (title: string) => HTMLElement, title: string): Element {
  return getByTitle(title).closest('div') as Element;
}

describe('VolumeControl', () => {
  it('clicking the speaker button dispatches onToggleMute', () => {
    const onToggleMute = vi.fn();
    const { getByTitle } = render(<VolumeControl {...baseProps} onToggleMute={onToggleMute} />);
    fireEvent.click(getByTitle('Mute (M)'));
    expect(onToggleMute).toHaveBeenCalled();
  });

  it('titles the button "Unmute (M)" once muted', () => {
    const { getByTitle } = render(<VolumeControl {...baseProps} muted={true} />);
    expect(getByTitle('Unmute (M)')).toBeTruthy();
  });

  it('the popover is hidden until the group is hovered', () => {
    const { getByTitle, queryByText } = render(<VolumeControl {...baseProps} />);
    expect(queryByText('70%')).toBeNull();
    fireEvent.mouseEnter(group(getByTitle, 'Mute (M)'));
    expect(queryByText('70%')).toBeTruthy();
  });

  it('shows no percentage text in the readout while muted', () => {
    const { getByTitle, queryByText } = render(<VolumeControl {...baseProps} muted={true} />);
    fireEvent.mouseEnter(group(getByTitle, 'Unmute (M)'));
    expect(queryByText('70%')).toBeNull();
  });

  it('closes on a timer after the pointer leaves, via the injected scheduler', () => {
    const scheduler = new FakeScheduler();
    const { getByTitle, queryByText } = render(<VolumeControl {...baseProps} scheduler={scheduler} />);
    const el = group(getByTitle, 'Mute (M)');
    fireEvent.mouseEnter(el);
    expect(queryByText('70%')).toBeTruthy();
    fireEvent.mouseLeave(el);
    // Still open -- the close callback hasn't fired yet, just been scheduled.
    expect(queryByText('70%')).toBeTruthy();
    expect(scheduler.pendingCount).toBe(1);
    act(() => {
      scheduler.runAllPending();
    });
    expect(queryByText('70%')).toBeNull();
  });

  it('re-entering the group before the close timer fires cancels it (travel from button to slider)', () => {
    const scheduler = new FakeScheduler();
    const { getByTitle, queryByText } = render(<VolumeControl {...baseProps} scheduler={scheduler} />);
    const el = group(getByTitle, 'Mute (M)');
    fireEvent.mouseEnter(el);
    fireEvent.mouseLeave(el);
    fireEvent.mouseEnter(el);
    expect(scheduler.pendingCount).toBe(0);
    act(() => {
      scheduler.runAllPending();
    });
    expect(queryByText('70%')).toBeTruthy();
  });

  it('pointerdown on the track calls onSetVolume', () => {
    const onSetVolume = vi.fn();
    const { getByTitle, container } = render(<VolumeControl {...baseProps} onSetVolume={onSetVolume} />);
    fireEvent.mouseEnter(group(getByTitle, 'Mute (M)'));
    const track = container.querySelector('[class*="trackWrap"]') as HTMLElement;
    track.setPointerCapture = () => {};
    fireEvent.pointerDown(track, { clientX: 42, pointerId: 1 });
    expect(onSetVolume).toHaveBeenCalled();
  });

  it('dragging the track while muted calls onUnmute', () => {
    const onUnmute = vi.fn();
    const { getByTitle, container } = render(<VolumeControl {...baseProps} muted={true} onUnmute={onUnmute} />);
    fireEvent.mouseEnter(group(getByTitle, 'Unmute (M)'));
    const track = container.querySelector('[class*="trackWrap"]') as HTMLElement;
    track.setPointerCapture = () => {};
    fireEvent.pointerDown(track, { clientX: 10, pointerId: 1 });
    expect(onUnmute).toHaveBeenCalled();
  });

  it('dragging the track while unmuted never calls onUnmute', () => {
    const onUnmute = vi.fn();
    const { getByTitle, container } = render(<VolumeControl {...baseProps} onUnmute={onUnmute} />);
    fireEvent.mouseEnter(group(getByTitle, 'Mute (M)'));
    const track = container.querySelector('[class*="trackWrap"]') as HTMLElement;
    track.setPointerCapture = () => {};
    fireEvent.pointerDown(track, { clientX: 10, pointerId: 1 });
    expect(onUnmute).not.toHaveBeenCalled();
  });
});
