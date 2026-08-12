// The shape both real derivation (derive-source-info.ts) and the design fixture (../fixtures.ts)
// produce, so TrackList/SourcePanel/ExportPanel render either identically -- moved out of
// fixtures.ts once it stopped being fixture-only.

import type { TrackId } from '../state/app-state.ts';

export interface TrackSummary {
  id: TrackId;
  /** The real MP4 track id -- unlike `id` (a synthesized display id, V1/A1/A2/...), this is what
   * export needs to map a selection back to `SampleIndex`/`TrackIndex` calls. */
  trackId: number;
  name: string;
  meta: string;
  kind: 'video' | 'audio';
  locked?: boolean;
}
