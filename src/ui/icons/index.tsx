// Inline SVG icon set, paths transcribed from design/reference/Video Trimmer.dc.html's ICON/
// T_ICON tables and inline template markup -- per design/README.md's Assets section: "swap them
// for the codebase's icon set... currentColor" -- 16x16/20x20 viewBox, stroke-width 1.3. A few
// icons hardcode a specific token color rather than `currentColor` because the source design does
// too (e.g. the checkbox tick is always accent/on, regardless of the button's own color) -- those
// reference the CSS custom property, never a literal hex, so tokens.test.ts's scanner still holds.
import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

export function InfoIcon(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <circle cx={8} cy={8} r={6} />
      <path d="M8 7.2v4" />
      <circle cx={8} cy={4.9} r={0.55} fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx={5.5} cy={4.5} r={1.5} fill="var(--color-bg-panel)" />
      <circle cx={10} cy={8} r={1.5} fill="var(--color-bg-panel)" />
      <circle cx={6.5} cy={11.5} r={1.5} fill="var(--color-bg-panel)" />
    </svg>
  );
}

export function QueueIcon(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <rect x={2} y={3} width={12} height={3.2} rx={1} />
      <rect x={2} y={9.8} width={12} height={3.2} rx={1} />
    </svg>
  );
}

export function KeysIcon(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <rect x={1.5} y={4} width={13} height={8} rx={1.5} />
      <path d="M5 9.6h6" />
      <circle cx={4.6} cy={6.8} r={0.5} fill="currentColor" stroke="none" />
      <circle cx={8} cy={6.8} r={0.5} fill="currentColor" stroke="none" />
      <circle cx={11.4} cy={6.8} r={0.5} fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PrevKeyframeIcon(props: IconProps) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M6 5.5v9" />
      <path d="M14.5 5.5L8.5 10l6 4.5z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function StepBackIcon(props: IconProps) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M12.5 5.5L7 10l5.5 4.5z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" fill="currentColor" {...props}>
      <path d="M6.5 4.5l9 5.5-9 5.5z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" fill="currentColor" {...props}>
      <rect x={6} y={5} width={3} height={10} rx={1} />
      <rect x={11} y={5} width={3} height={10} rx={1} />
    </svg>
  );
}

export function StepForwardIcon(props: IconProps) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M7.5 5.5L13 10l-5.5 4.5z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function NextKeyframeIcon(props: IconProps) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M14 5.5v9" />
      <path d="M5.5 5.5L11.5 10l-6 4.5z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <circle cx={6} cy={4.5} r={2.4} />
      <path d="M6 7v4" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      fill="none"
      stroke="var(--color-accent-on)"
      strokeWidth={1.6}
      {...props}
    >
      <path d="M1.4 4.2L3.1 6 6.6 2.3" />
    </svg>
  );
}

export function WarningTriangleIcon(props: IconProps) {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.3} {...props}>
      <path d="M6 1.6L11 10.4H1z" />
      <path d="M6 4.9v2.4" />
    </svg>
  );
}

/** Speaker cone shared by the volume control's three icon states -- chrome/VolumeControl.tsx. */
function SpeakerCone() {
  return <path d="M2 6.3h2.4L8 3.2v9.6L4.4 9.7H2z" fill="currentColor" stroke="none" />;
}

export function SpeakerMutedIcon(props: IconProps) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" {...props}>
      <SpeakerCone />
      <path d="M10.6 6.3l3.6 3.6M14.2 6.3l-3.6 3.6" />
    </svg>
  );
}

export function SpeakerLowIcon(props: IconProps) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" {...props}>
      <SpeakerCone />
      <path d="M10.4 6.2a3.3 3.3 0 0 1 0 5.6" />
    </svg>
  );
}

export function SpeakerHighIcon(props: IconProps) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" {...props}>
      <SpeakerCone />
      <path d="M10.4 6.2a3.3 3.3 0 0 1 0 5.6" />
      <path d="M12.3 4.3a6.2 6.2 0 0 1 0 9.4" />
    </svg>
  );
}

/** Empty-state drop-zone icon: a disk with a play triangle. */
export function FileDropIcon(props: IconProps) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--color-text-secondary)"
      strokeWidth={1.3}
      {...props}
    >
      <rect x={1.5} y={3.5} width={13} height={9} rx={1.5} />
      <path d="M6.5 6.4v3.2L9.8 8z" />
    </svg>
  );
}
