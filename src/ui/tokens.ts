// Transcribed from design/README.md's "Design Tokens" section, plus a handful of colors that
// only appear in prose elsewhere in that document (see the comment on each). This is the sole
// hex-literal source in src/ui/ -- every other file references these names, never a literal.

export const color = {
  bgBase: '#0E0E0F',
  bgStage: '#0B0B0C',
  bgPanel: '#1A1A1C',
  bgRaised: '#232326',
  // A slightly lighter hover state used on top of bg/raised buttons -- "Keep exact frame" and
  // "Show in folder" in design/reference/Video Trimmer.dc.html, not in the main token table.
  bgRaisedHover: '#2A2A2E',
  bgTimeline: '#141416',
  // Indexing-state stripe overlay -- design/README.md's Timeline "Indexing state" note.
  bgIndexingStripeA: '#151517',
  bgIndexingStripeB: '#121214',
  bgKeyframes: '#121215',
  bgWaveform: '#0F0F11',
  bgTileEmpty: '#1B1B1F',
  // Splitter hover -- design/reference/Video Trimmer.dc.html's `style-hover` on the splitter row,
  // not in the main token table.
  bgSplitterHover: '#16161A',

  borderBase: '#2E2E32',
  borderSubtle: '#232326',
  // Track-list checkbox unchecked border -- design/README.md's track-list row description, not
  // the main token table.
  borderCheckbox: '#3A3A3E',

  textPrimary: '#E8E8E6',
  textSecondary: '#9A9A96',
  textTertiary: '#6B6B68',
  textDisabled: '#4A4A4E',

  accent: '#4C8DF6',
  accentHover: '#5E99F7',
  accentActive: '#7FB0FF',
  accentOn: '#0B1220',
  // Selected export-track row tint -- design/README.md's track-list section.
  accentSelectedBg: 'rgba(76,141,246,.10)',

  good: '#5DCAA5',
  warn: '#EF9F27',
  warnBright: '#FFB84D',
  // Two distinct amber pills at different opacities: the title-bar "reconnect file" banner,
  // and the status-bar keyframe-shift notice pill.
  warnBannerBg: 'rgba(239,159,39,.10)',
  warnBannerBorder: 'rgba(239,159,39,.35)',
  warnNoticeBg: 'rgba(239,159,39,.14)',
  warnNoticeBorder: 'rgba(239,159,39,.45)',
  // The title-bar reconnect button's own border/hover -- a third, lighter amber pairing used only
  // on that inline button, not the pill it sits inside.
  warnButtonBorder: 'rgba(239,159,39,.5)',
  warnButtonHoverBg: 'rgba(239,159,39,.16)',

  playhead: '#E2574F',
  dim: 'rgba(10,10,11,.72)',
  // Keyboard-overlay full-screen scrim -- design/README.md's Keyboard overlay section.
  scrim: 'rgba(8,8,9,.72)',
} as const;

export const type = {
  fontSans: "'IBM Plex Sans', sans-serif",
  fontMono: "'IBM Plex Mono', monospace",
  weightSans: [400, 500, 600],
  weightMono: [400, 500],
  size: [10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15],
} as const;

export const spacing = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 26, 32, 40] as const;

export const radius = [2, 3, 4, 5, 6, 8] as const;

export const shadow = {
  panel: '0 12px 32px rgba(0,0,0,.55)',
  exportOverlay: '0 10px 26px rgba(0,0,0,.5)',
} as const;

// Fixed pixel heights/widths named explicitly in design/README.md's "Row heights" token line.
export const rowHeight = {
  title: 40,
  degradedStrip: 22,
  transport: 36,
  status: 30,
  ruler: 22,
  keyframes: 15,
  waveform: 26,
  splitter: 5,
  railWidth: 34,
  floatingPanel: 250,
  pinnedPanel: 258,
} as const;

export const motion = {
  panelFadeMs: 120,
  toastRiseMs: 180,
  snapFlashMs: 450,
  panelHoverOpenMs: 400,
  panelCloseMs: 220,
  easingOut: 'ease-out',
} as const;
