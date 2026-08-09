import { ExportPanel } from '../panels/ExportPanel.tsx';
import { JobsPanel } from '../panels/JobsPanel.tsx';
import { SourcePanel } from '../panels/SourcePanel.tsx';
import { FloatingPanel } from './FloatingPanel.tsx';
import { PinnedPanel } from './PinnedPanel.tsx';
import { PreviewSurface } from './PreviewSurface.tsx';
import { Rail } from './Rail.tsx';
import styles from './Stage.module.css';
import type { ReactNode, RefObject } from 'react';
import type { PanelId, Screen, TrackId, TrackSelection } from '../state/app-state.ts';
import type { UnsupportedInfo } from '../state/media-session.ts';
import type { PanelRowFixture } from '../media/panel-row.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface StageProps {
  screen: Screen;
  showChrome: boolean;
  panel: PanelId | null;
  pinned: PanelId | null;
  shortcuts: boolean;
  tracks: readonly TrackSummary[];
  sourceRows: readonly PanelRowFixture[];
  sourceFileName: string;
  sel: TrackSelection;
  tin: number;
  tout: number;
  frameLabel: string;
  timecode: string;
  openErrorMessage?: string | null;
  unsupported?: UnsupportedInfo | null;
  videoRef?: RefObject<HTMLVideoElement | null>;
  onOpenFile: () => void;
  onFileDrop: (file: File) => void;
  onOpenPanel: (id: PanelId) => void;
  onClosePanel: () => void;
  onPinPanel: (id: PanelId) => void;
  onUnpinPanel: () => void;
  onToggleShortcuts: () => void;
  onToggleTrack: (id: TrackId) => void;
  overlay?: ReactNode;
  toast?: ReactNode;
}

const PANEL_TITLES: Record<PanelId, string> = { info: 'Source', export: 'Export', queue: 'Jobs' };

export function Stage({
  screen,
  showChrome,
  panel,
  pinned,
  shortcuts,
  tracks,
  sourceRows,
  sourceFileName,
  sel,
  tin,
  tout,
  frameLabel,
  timecode,
  openErrorMessage,
  unsupported,
  videoRef,
  onOpenFile,
  onFileDrop,
  onOpenPanel,
  onClosePanel,
  onPinPanel,
  onUnpinPanel,
  onToggleShortcuts,
  onToggleTrack,
  overlay,
  toast,
}: StageProps) {
  function renderPanelContent(id: PanelId) {
    switch (id) {
      case 'info':
        return <SourcePanel tracks={tracks} rows={sourceRows} />;
      case 'export':
        return (
          <ExportPanel tracks={tracks} sel={sel} tin={tin} tout={tout} sourceFileName={sourceFileName} onToggleTrack={onToggleTrack} />
        );
      case 'queue':
        return <JobsPanel />;
    }
  }

  const previewScreen = screen === 'empty' || screen === 'degraded' ? 'empty' : screen === 'unsupported' ? 'unsupported' : 'has-video';

  return (
    <div className={styles.root}>
      <PreviewSurface
        screen={previewScreen}
        frameLabel={frameLabel}
        timecode={timecode}
        onOpen={onOpenFile}
        onFileDrop={onFileDrop}
        openErrorMessage={openErrorMessage}
        unsupported={unsupported}
        videoRef={videoRef}
      >
        {overlay}
        {toast}
      </PreviewSurface>

      {pinned !== null && (
        <PinnedPanel title={PANEL_TITLES[pinned]} onUnpin={onUnpinPanel}>
          {renderPanelContent(pinned)}
        </PinnedPanel>
      )}

      {showChrome && (
        <Rail
          panel={panel}
          pinned={pinned}
          shortcuts={shortcuts}
          onOpenPanel={onOpenPanel}
          onClosePanel={onClosePanel}
          onToggleShortcuts={onToggleShortcuts}
        />
      )}

      {panel !== null && (
        <FloatingPanel
          title={PANEL_TITLES[panel]}
          onPin={() => {
            onPinPanel(panel);
          }}
          onClose={onClosePanel}
        >
          {renderPanelContent(panel)}
        </FloatingPanel>
      )}
    </div>
  );
}
