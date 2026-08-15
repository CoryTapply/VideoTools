// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NoticeChip } from './NoticeChip.tsx';
import type { KeyframeShiftNotice } from '../state/app-state.ts';

afterEach(cleanup);

const notice: KeyframeShiftNotice = { delta: -4.17, at: 6690, which: 'start' };

const baseProps = {
  notice,
  noticeOpen: true,
  onNoticeEnter: () => {},
  onNoticeLeave: () => {},
  onKeepExact: () => {},
  onDismissNotice: () => {},
  fps: 60,
  rightPx: 14,
  marginRightPx: 34,
  bottomPx: 307,
};

describe('NoticeChip', () => {
  it('renders nothing when there is no notice', () => {
    const { container } = render(<NoticeChip {...baseProps} notice={null} exactAvailable={true} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Keep exact frame" when exactAvailable', () => {
    const { getByText } = render(<NoticeChip {...baseProps} exactAvailable={true} />);
    expect(getByText('Keep exact frame')).toBeTruthy();
  });

  it('hides "Keep exact frame" and the footnote when !exactAvailable', () => {
    const { queryByText } = render(<NoticeChip {...baseProps} exactAvailable={false} />);
    expect(queryByText('Keep exact frame')).toBeNull();
    expect(queryByText('Re-encodes ~4 s at the head of the clip.')).toBeNull();
  });

  it('Dismiss click calls onDismissNotice', () => {
    const onDismissNotice = vi.fn();
    const { getByText } = render(<NoticeChip {...baseProps} exactAvailable={true} onDismissNotice={onDismissNotice} />);
    fireEvent.click(getByText('Dismiss'));
    expect(onDismissNotice).toHaveBeenCalled();
  });

  it('Keep exact frame click calls onKeepExact', () => {
    const onKeepExact = vi.fn();
    const { getByText } = render(<NoticeChip {...baseProps} exactAvailable={true} onKeepExact={onKeepExact} />);
    fireEvent.click(getByText('Keep exact frame'));
    expect(onKeepExact).toHaveBeenCalled();
  });
});
