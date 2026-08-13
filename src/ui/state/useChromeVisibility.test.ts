// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { useChromeVisibility } from './useChromeVisibility.ts';
import { motion } from '../tokens.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useChromeVisibility', () => {
  it('defaults to visible', () => {
    const { result } = renderHook(() => useChromeVisibility(false));
    expect(result.current).toBe(true);
  });

  it('hides after chromeIdleMs of no activity', () => {
    const { result } = renderHook(() => useChromeVisibility(false));
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs);
    });
    expect(result.current).toBe(false);
  });

  it('pointermove on window re-arms the timer', () => {
    const { result } = renderHook(() => useChromeVisibility(false));
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs - 1);
      fireEvent.pointerMove(window);
    });
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('keydown on window wakes hidden chrome back to visible', () => {
    const { result } = renderHook(() => useChromeVisibility(false));
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs);
    });
    expect(result.current).toBe(false);
    act(() => {
      fireEvent.keyDown(window);
    });
    expect(result.current).toBe(true);
  });

  it('never hides while suppressHide is true', () => {
    const { result } = renderHook(() => useChromeVisibility(true));
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs * 3);
    });
    expect(result.current).toBe(true);
  });

  it('resumes counting down once suppressHide lifts', () => {
    const { result, rerender } = renderHook(({ suppress }) => useChromeVisibility(suppress), {
      initialProps: { suppress: true },
    });
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs * 3);
    });
    expect(result.current).toBe(true);
    rerender({ suppress: false });
    act(() => {
      vi.advanceTimersByTime(motion.chromeIdleMs);
    });
    expect(result.current).toBe(false);
  });
});
