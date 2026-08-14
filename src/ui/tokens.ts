// Transcribed from design/README.md's "Design Tokens" section, plus a handful of colors that
// only appear in prose elsewhere in that document (see the comment on each). This is the sole
// hex-literal source in src/ui/ -- every other file references these names, never a literal.

export const color = {
  bgBase: '#0E0E0F',
  bgStage: '#0B0B0C',
  // The <video> element's own background before a frame has decoded.
  bgVideo: '#000000',
  // Dev-harness backdrop (src/ui/harness/) -- not part of the shipped app, but still routed
  // through tokens.ts to keep tokens.test.ts's scanner honest.
  bgHarnessBackdrop: '#050506',
  // Export progress overlay's own translucent backing -- design/reference/Video Trimmer.dc.html.
  bgExportOverlay: 'rgba(19,19,21,.92)',
  // Empty-state drop-zone card and its hover fill -- design/reference/Video Trimmer.dc.html, not
  // in the main token table.
  bgEmptyState: '#111113',
  bgEmptyStateHover: '#131317',
  bgPanel: '#1A1A1C',
  bgRaised: '#232326',
  // A slightly lighter hover state used on top of bg/raised buttons -- "Keep exact frame" and
  // "Show in folder" in design/reference/Video Trimmer.dc.html, not in the main token table.
  bgRaisedHover: '#2A2A2E',
  bgTimeline: '#141416',
  // Indexing-state stripe overlay -- design/README.md's Timeline "Indexing state" note.
  bgIndexingStripeA: '#151517',
  bgIndexingStripeB: '#121214',
  bgWaveform: '#0F0F11',
  bgTileEmpty: '#1B1B1F',
  // The preview stage's placeholder-frame stripe texture (stands in for a real decoded frame) --
  // design/reference/Video Trimmer.dc.html's video-box background, not in the main token table.
  bgPreviewTextureA: '#131418',
  bgPreviewTextureB: '#0F1013',
  // Splitter hover -- design/reference/Video Trimmer.dc.html's `style-hover` on the splitter row,
  // not in the main token table.
  bgSplitterHover: '#16161A',
  // Floating title bar's gradient scrim (replaces the old row's border-bottom) --
  // design/floating-chrome-changes.md's "Title bar floats over the preview".
  titleScrimTop: 'rgba(11,11,12,.94)',
  titleScrimBottom: 'rgba(11,11,12,0)',
  // Floating transport pill's background -- design/floating-chrome-changes.md's "Transport becomes
  // a floating pill".
  transportPillBg: 'rgba(14,14,15,.9)',

  borderBase: '#2E2E32',
  borderSubtle: '#232326',
  // Track-list checkbox unchecked border -- design/README.md's track-list row description, not
  // the main token table.
  borderCheckbox: '#3A3A3E',
  // Empty-state drop card's dashed border -- design/empty-state-changes.md.
  borderEmptyCard: '#34343A',
  // Rule under the empty-state Recent-files header -- design/empty-state-changes.md.
  borderRecentRule: '#1F1F23',
  // Empty-state Recent row hover fill -- design/empty-state-changes.md. Coincides with
  // bg/timeline's hex value but is kept as its own token: the two are semantically unrelated.
  bgRecentRowHover: '#141416',
  // Empty-state panel skeleton bar tones (label = dimmer/left, value = brighter/right) --
  // design/empty-state-changes.md's "Key/value skeleton rows" and "Track skeleton" sections.
  skeletonBarLabel: '#202024',
  skeletonBarValue: '#26262A',
  // Empty-state track-skeleton's inert (non-pulsing) checkbox placeholder border --
  // design/empty-state-changes.md's "Track skeleton" section.
  borderSkeletonCheckbox: '#2A2A2E',

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

  // Ruler row (canvas draw code, Task 4b) -- design/README.md's Ruler section. Major ticks reuse
  // textDisabled (#4A4A4E) and labels reuse textTertiary (#6B6B68), both already named above.
  tickMinor: '#2A2A2E',
  // Keyframe row's two density bands (>=16px full-height, 3-16px short) -- same section.
  keyframeTickFull: '#8A8A92',
  keyframeTickShort: '#6E6E76',
  // Filmstrip tile seam -- design/README.md's Filmstrip `box-shadow` seam, drawn as two 1px lines
  // rather than a CSS box-shadow since tiles are canvas-drawn, not DOM nodes.
  filmstripSeamDark: 'rgba(0,0,0,.55)',
  filmstripSeamLight: 'rgba(255,255,255,.05)',
  // In/out region -- design/README.md's In/out region: the selected span's top/bottom borders,
  // and the handle's grip line (drawn over the accent-colored bar).
  selectionBorder: 'rgba(76,141,246,.55)',
  handleGrip: 'rgba(11,18,32,.55)',

  // Volume popover's slider track (unfilled portion) -- design/volume-slider-prompt.md. Coincides
  // with skeletonBarValue's hex but kept as its own token: unrelated features.
  volumeTrackBg: '#26262A',
  // Speaker button's active background when muted -- design/volume-slider-prompt.md. A fourth,
  // distinct amber-tint pairing alongside warnBannerBg/warnNoticeBg/warnButtonHoverBg above.
  warnVolumeActiveBg: 'rgba(239,159,39,.14)',
} as const;

export const type = {
  // Helvetica Neue is a system font -- no Google Fonts load, Helvetica/Arial cover the machines
  // without it. Azeret Mono is loaded from Google Fonts (see app.html/ui-harness.html).
  fontSans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontMono: "'Azeret Mono', ui-monospace, monospace",
  // Helvetica Neue has a hard 400 -> 700 jump (500/600 snap to bold or get synthetically
  // emboldened), so the UI face stays at 400 only. Azeret Mono has a real medium.
  weightSans: [400],
  weightMono: [400, 500],
  size: [10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15],
} as const;

export const spacing = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 26, 32, 40] as const;

export const radius = [2, 3, 4, 5, 6, 8] as const;

export const shadow = {
  panel: '0 12px 32px rgba(0,0,0,.55)',
  exportOverlay: '0 10px 26px rgba(0,0,0,.5)',
  // Floating transport pill -- design/floating-chrome-changes.md's "Transport becomes a floating
  // pill".
  transportPill: '0 10px 28px rgba(0,0,0,.45)',
  // Volume popover -- design/volume-slider-prompt.md. Same value as exportOverlay's but kept
  // separate: unrelated floating surfaces.
  volumePopover: '0 10px 26px rgba(0,0,0,.5)',
} as const;

// Fixed pixel heights/widths named explicitly in design/README.md's "Row heights" token line
// (updated by design/floating-chrome-changes.md: title/transport/status no longer occupy column
// height, ruler absorbs the old keyframe row).
export const rowHeight = {
  titleOverlay: 44,
  degradedStrip: 22,
  transportPill: 40,
  ruler: 26,
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
  // Chrome auto-hide idle timeout and cross-fade duration --
  // design/floating-chrome-changes.md's "Auto-hide behaviour".
  chromeIdleMs: 2000,
  chromeFadeMs: 180,
  // Volume popover's leave-to-close delay -- design/volume-slider-prompt.md's "~250ms", distinct
  // from panelCloseMs's 220ms (a different floating surface with its own spec).
  volumePopoverCloseMs: 250,
  easingOut: 'ease-out',
} as const;
