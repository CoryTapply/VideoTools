// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimelineRegion } from './TimelineRegion.tsx';

afterEach(cleanup);

describe('TimelineRegion', () => {
  it('renders a canvas and sizes the root to heightPx', () => {
    const { container } = render(<TimelineRegion heightPx={236} indexing={false} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.height).toBe('236px');
    expect(root.querySelector('canvas')).not.toBeNull();
  });

  it('shows the indexing overlay only while indexing, positioned below the ruler/keyframe rows', () => {
    const { container, rerender } = render(<TimelineRegion heightPx={236} indexing={false} />);
    expect(container.querySelector('[class*="indexingOverlay"]')).toBeNull();

    rerender(<TimelineRegion heightPx={236} indexing={true} />);
    const overlay = container.querySelector('[class*="indexingOverlay"]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.top).toBe('37px'); // rowHeight.ruler (22) + rowHeight.keyframes (15)
  });

  it('does not throw when getContext("2d") is unavailable, as under jsdom', () => {
    expect(() => render(<TimelineRegion heightPx={236} indexing={false} />)).not.toThrow();
  });
});
