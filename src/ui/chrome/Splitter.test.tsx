// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Splitter } from './Splitter.tsx';

afterEach(cleanup);

// jsdom doesn't implement pointer capture (every Chromium target does) -- stub it so the
// component's real setPointerCapture/releasePointerCapture calls don't throw under test.
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

describe('Splitter', () => {
  it('dragging down shrinks the timeline height, clamped', () => {
    const onResize = vi.fn();
    const { container } = render(<Splitter timelineHeight={300} onResize={onResize} />);
    const handle = container.firstElementChild as Element;

    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 140, pointerId: 1 });

    expect(onResize).toHaveBeenCalledWith(260);
  });

  it('does not resize before a pointer-down', () => {
    const onResize = vi.fn();
    const { container } = render(<Splitter timelineHeight={300} onResize={onResize} />);
    const handle = container.firstElementChild as Element;
    fireEvent.pointerMove(handle, { clientY: 140, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
