// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Rail } from './Rail.tsx';

afterEach(cleanup);

describe('Rail', () => {
  it('click opens a panel', () => {
    const onOpenPanel = vi.fn();
    const { getByTitle } = render(
      <Rail panel={null} pinned={null} shortcuts={false} onOpenPanel={onOpenPanel} onClosePanel={() => {}} onToggleShortcuts={() => {}} />,
    );
    fireEvent.click(getByTitle('Source info'));
    expect(onOpenPanel).toHaveBeenCalledWith('info');
  });

  it('click closes the panel that is already open', () => {
    const onClosePanel = vi.fn();
    const { getByTitle } = render(
      <Rail panel="info" pinned={null} shortcuts={false} onOpenPanel={() => {}} onClosePanel={onClosePanel} onToggleShortcuts={() => {}} />,
    );
    fireEvent.click(getByTitle('Source info'));
    expect(onClosePanel).toHaveBeenCalled();
  });

  it('the keyboard button toggles shortcuts, not a panel', () => {
    const onToggleShortcuts = vi.fn();
    const { getByTitle } = render(
      <Rail panel={null} pinned={null} shortcuts={false} onOpenPanel={() => {}} onClosePanel={() => {}} onToggleShortcuts={onToggleShortcuts} />,
    );
    fireEvent.click(getByTitle('Keyboard (?)'));
    expect(onToggleShortcuts).toHaveBeenCalled();
  });

  it('hover-open fires after 400ms when no panel is already open', () => {
    vi.useFakeTimers();
    const onOpenPanel = vi.fn();
    const { getByTitle } = render(
      <Rail panel={null} pinned={null} shortcuts={false} onOpenPanel={onOpenPanel} onClosePanel={() => {}} onToggleShortcuts={() => {}} />,
    );
    fireEvent.mouseEnter(getByTitle('Jobs'));
    vi.advanceTimersByTime(400);
    expect(onOpenPanel).toHaveBeenCalledWith('queue');
    vi.useRealTimers();
  });

  it('hover-open does not fire while a panel is already open', () => {
    vi.useFakeTimers();
    const onOpenPanel = vi.fn();
    const { getByTitle } = render(
      <Rail panel="info" pinned={null} shortcuts={false} onOpenPanel={onOpenPanel} onClosePanel={() => {}} onToggleShortcuts={() => {}} />,
    );
    fireEvent.mouseEnter(getByTitle('Jobs'));
    vi.advanceTimersByTime(400);
    expect(onOpenPanel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('mouse-leave before 400ms cancels the hover-open', () => {
    vi.useFakeTimers();
    const onOpenPanel = vi.fn();
    const { getByTitle } = render(
      <Rail panel={null} pinned={null} shortcuts={false} onOpenPanel={onOpenPanel} onClosePanel={() => {}} onToggleShortcuts={() => {}} />,
    );
    const jobsButton = getByTitle('Jobs');
    fireEvent.mouseEnter(jobsButton);
    vi.advanceTimersByTime(200);
    fireEvent.mouseLeave(jobsButton);
    vi.advanceTimersByTime(400);
    expect(onOpenPanel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
