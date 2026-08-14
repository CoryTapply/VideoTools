// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { App } from './App.tsx';
import type { Screen } from './state/app-state.ts';

afterEach(cleanup);

const SCREENS: readonly Screen[] = ['ready', 'empty', 'opening', 'indexing', 'exporting', 'finalising', 'unsupported', 'degraded'];

describe('App', () => {
  for (const screen of SCREENS) {
    it(`renders the ${screen} screen without throwing`, () => {
      const { container } = render(<App initialState={{ screen }} />);
      expect(container.firstElementChild).not.toBeNull();
    });
  }

  it('renders the permission-lost reconnect pill independently of screen', () => {
    const { getByText } = render(<App initialState={{ screen: 'ready', permissionLost: true }} />);
    expect(getByText('Reconnect file — access to this file was lost')).toBeTruthy();
  });

  it('renders the degraded caption strip only for screen === degraded', () => {
    const { queryByText } = render(<App initialState={{ screen: 'ready' }} />);
    expect(queryByText('Saves via download — capped at 2 GB in this browser')).toBeNull();
  });

  it('hides the title bar and transport bar for screen === empty', () => {
    const { queryByText, queryByTitle } = render(<App initialState={{ screen: 'empty' }} />);
    expect(queryByText('No file open')).toBeNull();
    // TransportBar's play/pause button, identified by its title attribute.
    expect(queryByTitle('Play · pause (Space)')).toBeNull();
  });

  it('shows the title bar and transport bar for screen === ready', () => {
    const { getByText, getByTitle } = render(<App initialState={{ screen: 'ready' }} />);
    // fixtures.ts's FILE_NAME fallback, rendered by the floating title bar.
    expect(getByText('session-4.mp4')).toBeTruthy();
    expect(getByTitle('Play · pause (Space)')).toBeTruthy();
  });

  it('Alt+I (clear-in) resets the in point to 00:00:00:00', () => {
    const { getByText } = render(<App initialState={{ screen: 'ready' }} />);
    fireEvent.keyDown(window, { key: 'i', altKey: true });
    expect(getByText('00:00:00:00')).toBeTruthy();
  });

  it('Alt+O (clear-out) is a no-op without a real file open (no known duration)', () => {
    const { queryByText } = render(<App initialState={{ screen: 'ready', tout: 6812 }} />);
    fireEvent.keyDown(window, { key: 'o', altKey: true });
    // 6812s at the fixture's 60fps -- unchanged, since media.durationSeconds is null pre-file-open.
    expect(queryByText('01:53:32:00')).toBeTruthy();
  });

  it('M toggles mute; the speaker button title reflects the new state', () => {
    const { getByTitle } = render(<App initialState={{ screen: 'ready' }} />);
    expect(getByTitle('Mute (M)')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'm' });
    expect(getByTitle('Unmute (M)')).toBeTruthy();
  });

  it('Shift+ArrowUp raises volume, reflected in the popover readout on hover', () => {
    const { getByTitle, getByText } = render(<App initialState={{ screen: 'ready' }} />);
    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true });
    // Fixture default vol is 0.7 (see app-state.ts) -- +0.05 -> 0.75 -> "75%".
    fireEvent.mouseEnter(getByTitle('Mute (M)').closest('div') as Element);
    expect(getByText('75%')).toBeTruthy();
  });

  it('"Keep exact frame" restores the pre-enforcement in point and switches to exact mode', () => {
    // notice.at (6690.5s) is the keyframe-enforced value; notice.delta (0.5s) is enforced-minus-
    // original, so the restored value should be 6690.5 - 0.5 = 6690s.
    const { getByText } = render(
      <App initialState={{ screen: 'ready', tin: 6690.5, tout: 6812, notice: { delta: 0.5, at: 6690.5, which: 'in' }, noticeOpen: true }} />,
    );
    fireEvent.click(getByText('Keep exact frame'));
    // 6690s at the fixture's 60fps -- HH:MM:SS:FF.
    expect(getByText('01:51:30:00')).toBeTruthy();
  });
});
