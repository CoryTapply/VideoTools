// The shape both real derivation (derive-source-info.ts) and the design fixture (../fixtures.ts)
// produce, so TrackList/SourcePanel/ExportPanel render either identically -- moved out of
// fixtures.ts once it stopped being fixture-only.

import type { TrackId } from '../state/app-state.ts';

export interface TrackSummary {
  id: TrackId;
  name: string;
  meta: string;
  kind: 'video' | 'audio';
  locked?: boolean;
}
