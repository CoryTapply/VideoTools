// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { EmptyState } from './EmptyState.tsx';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('EmptyState', () => {
  it('renders the copy verbatim', () => {
    const { getByText } = render(<EmptyState onOpen={() => {}} onFileDrop={() => {}} />);
    expect(getByText('Drop a video file to start trimming')).toBeTruthy();
    expect(getByText('Nothing uploads — the file is read from disk in this tab.')).toBeTruthy();
    expect(getByText('Choose file')).toBeTruthy();
    expect(getByText('⌘O')).toBeTruthy();
  });

  it('calls onOpen exactly once when Choose file is clicked, not twice via bubbling to the card', () => {
    const onOpen = vi.fn();
    const { getByText } = render(<EmptyState onOpen={onOpen} onFileDrop={() => {}} />);
    fireEvent.click(getByText('Choose file'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onOpen when the card itself is clicked', () => {
    const onOpen = vi.fn();
    const { getByText } = render(<EmptyState onOpen={onOpen} onFileDrop={() => {}} />);
    fireEvent.click(getByText('Drop a video file to start trimming'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('hides the Recent block entirely when localStorage has no entries', () => {
    const { queryByText } = render(<EmptyState onOpen={() => {}} onFileDrop={() => {}} />);
    expect(queryByText('Recent')).toBeNull();
  });

  it('shows the Recent block and rows, and clicking a row calls onOpen, when entries exist', () => {
    localStorage.setItem('videotools.recentFiles', JSON.stringify([{ name: 'session-4.mp4', openedAt: Date.now() }]));
    const onOpen = vi.fn();
    const { getByText } = render(<EmptyState onOpen={onOpen} onFileDrop={() => {}} />);
    expect(getByText('Recent')).toBeTruthy();
    fireEvent.click(getByText('session-4.mp4'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the error subtitle instead of the default subtitle when errorMessage is set', () => {
    const { getByText, queryByText } = render(<EmptyState onOpen={() => {}} onFileDrop={() => {}} errorMessage="Could not read this file" />);
    expect(getByText('Could not read this file')).toBeTruthy();
    expect(queryByText('Nothing uploads — the file is read from disk in this tab.')).toBeNull();
  });
});
