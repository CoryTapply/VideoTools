// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
});
