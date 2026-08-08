// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StatusBar } from './StatusBar.tsx';
import type { KeyframeShiftNotice } from '../state/app-state.ts';

afterEach(cleanup);

const notice: KeyframeShiftNotice = { delta: -4.17, at: 6690, which: 'in' };

const baseProps = {
  zoomLabel: '1 frame = 5px',
  thumbLabel: 'thumbs 68%',
  indexLabel: 'index 862,401 frames',
  notice,
  noticeOpen: true,
  onNoticeEnter: () => {},
  onNoticeLeave: () => {},
  onKeepExact: () => {},
  onDismissNotice: () => {},
  fps: 60,
};

describe('StatusBar', () => {
  it('renders nothing notice-related when there is no notice', () => {
    const { queryByText } = render(<StatusBar {...baseProps} notice={null} exactAvailable={true} />);
    expect(queryByText('in moved')).toBeNull();
  });

  it('shows "Keep exact frame" when exactAvailable', () => {
    const { getByText } = render(<StatusBar {...baseProps} exactAvailable={true} />);
    expect(getByText('Keep exact frame')).toBeTruthy();
  });

  it('hides "Keep exact frame" and the footnote when !exactAvailable', () => {
    const { queryByText } = render(<StatusBar {...baseProps} exactAvailable={false} />);
    expect(queryByText('Keep exact frame')).toBeNull();
    expect(queryByText('Re-encodes ~4 s at the head of the clip.')).toBeNull();
  });

  it('Dismiss click calls onDismissNotice', () => {
    const onDismissNotice = vi.fn();
    const { getByText } = render(<StatusBar {...baseProps} exactAvailable={true} onDismissNotice={onDismissNotice} />);
    fireEvent.click(getByText('Dismiss'));
    expect(onDismissNotice).toHaveBeenCalled();
  });

  it('Keep exact frame click calls onKeepExact', () => {
    const onKeepExact = vi.fn();
    const { getByText } = render(<StatusBar {...baseProps} exactAvailable={true} onKeepExact={onKeepExact} />);
    fireEvent.click(getByText('Keep exact frame'));
    expect(onKeepExact).toHaveBeenCalled();
  });
});
