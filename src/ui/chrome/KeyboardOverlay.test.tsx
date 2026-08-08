// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { KEY_ROWS } from '../fixtures.ts';
import { KeyboardOverlay } from './KeyboardOverlay.tsx';

afterEach(cleanup);

describe('KeyboardOverlay', () => {
  it('renders every chord row from the keyboard map', () => {
    const { getByText } = render(<KeyboardOverlay onClose={() => {}} />);
    for (const row of KEY_ROWS) {
      expect(getByText(row.chord)).toBeTruthy();
    }
  });

  it('clicking the scrim calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<KeyboardOverlay onClose={onClose} />);
    const scrim = container.firstElementChild;
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);
    expect(onClose).toHaveBeenCalled();
  });
});
