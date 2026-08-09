// Shared with ../fixtures.ts -- the row shape both real derivation and the design fixture
// produce, so PanelRows.tsx renders either identically.

/** Matches the value colors PanelRows renders -- see ../panels/PanelRows.tsx. */
export type RowTone = 'neutral' | 'muted' | 'informational' | 'good' | 'warning';

export interface PanelRowFixture {
  label: string;
  value: string;
  tone: RowTone;
}
