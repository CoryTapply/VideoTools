// Shared types for the src/ui/timeline/ canvas layer stack (Task 4b). Unlike src/media/{index,
// playback,frames}, which each redeclare `Time = number` to stay mutually import-free, everything
// under this directory is already one tightly-coupled domain (draw functions consume geometry
// structs the pure modules produce), so one shared alias here avoids pointless repetition without
// adding any DOM/React dependency -- this file stays as import-free as they are.

/** Integer presentation ticks in the loaded file's primary video track's own timescale -- same
 * convention as src/media/frames/types.ts and src/media/playback/PlaybackEngine.ts. */
export type Time = number;

export interface Viewport {
  viewStart: Time;
  viewSpan: Time;
  widthPx: number;
}
