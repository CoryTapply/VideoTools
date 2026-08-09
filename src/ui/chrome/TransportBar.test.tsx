// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TransportBar } from './TransportBar.tsx';

afterEach(cleanup);

const baseProps = {
  timecode: '00:00:00:00',
  playing: false,
  onTogglePlay: () => {},
  onStepBack: () => {},
  onStepForward: () => {},
  onPrevKeyframe: () => {},
  onNextKeyframe: () => {},
  inTc: '00:00:00:00',
  outTc: '00:00:00:00',
  durTc: '00:00:00:00',
  trimMode: 'copy' as const,
  onSetTrimMode: () => {},
};

describe('TransportBar', () => {
  it('disables the exact segment when exactAvailable is false', () => {
    const { getByText } = render(<TransportBar {...baseProps} exactAvailable={false} />);
    expect((getByText('exact') as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the exact segment enabled when exactAvailable is true', () => {
    const { getByText } = render(<TransportBar {...baseProps} exactAvailable={true} />);
    expect((getByText('exact') as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking copy/exact dispatches onSetTrimMode', () => {
    const onSetTrimMode = vi.fn();
    const { getByText } = render(<TransportBar {...baseProps} exactAvailable={true} onSetTrimMode={onSetTrimMode} />);
    fireEvent.click(getByText('exact'));
    expect(onSetTrimMode).toHaveBeenCalledWith('exact');
  });

  it('play button click dispatches onTogglePlay', () => {
    const onTogglePlay = vi.fn();
    const { getByTitle } = render(<TransportBar {...baseProps} exactAvailable={true} onTogglePlay={onTogglePlay} />);
    fireEvent.click(getByTitle('Play · pause (Space)'));
    expect(onTogglePlay).toHaveBeenCalled();
  });
});
