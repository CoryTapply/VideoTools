// Owns the parts of "run a real export" that are resource-shaped, not reducer-shaped: the live
// ExportWorkerClient for the in-flight attempt and the completed result's display fields --
// mirroring media-session.ts's useMediaSession split. app-state.ts still owns
// screen/exportPct/toast/exportError; this hook dispatches into it at the right points.

import { useCallback, useRef, useState } from 'react';
// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { pickExportFile } from '../../media/export/picker.ts';
import { ExportWorkerClient } from '../../media/export/worker-client.ts';
import { defaultExportFileName, selectedRealTrackIds } from '../media/derive-source-info.ts';
import type { Dispatch } from 'react';
import type { TrackSelection } from './app-state.ts';
import type { MediaSession } from './media-session.ts';
import type { TrackSummary } from '../media/track-summary.ts';
import type { AppAction } from './app-state.ts';

export interface ExportSessionResult {
  outPath: string;
  durationLabel: string;
}

export interface StartExportOptions {
  tin: number;
  tout: number;
  sel: TrackSelection;
  tracks: readonly TrackSummary[];
  sourceFileName: string;
}

export interface ExportSession {
  startExport: (opts: StartExportOptions) => Promise<void>;
  cancelExport: () => void;
  lastResult: ExportSessionResult | null;
}

/** "2 m 02 s" / "17 s" -- matching fixtures.ts's EXPORT_DURATION_LABEL style. */
function formatDurationLabel(wallMs: number): string {
  const totalSeconds = Math.round(wallMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes.toString()} m ${seconds.toString().padStart(2, '0')} s` : `${seconds.toString()} s`;
}

export function useExportSession(dispatch: Dispatch<AppAction>, media: MediaSession): ExportSession {
  const clientRef = useRef<ExportWorkerClient | null>(null);
  const [lastResult, setLastResult] = useState<ExportSessionResult | null>(null);

  const startExport = useCallback(
    async (opts: StartExportOptions) => {
      dispatch({ type: 'screen/set', screen: 'exporting' });
      dispatch({ type: 'export-error/set', error: null });
      dispatch({ type: 'export/progress', pct: 0 });

      const file = media.file;
      const sampleIndex = media.sampleIndexRef.current;
      if (file === null || sampleIndex === null) {
        // Export was somehow triggered with no file open -- TitleBar's canExport guard should
        // already prevent this; fail closed rather than crash.
        dispatch({ type: 'screen/set', screen: 'ready' });
        return;
      }

      const picked = await pickExportFile(defaultExportFileName(opts.sourceFileName));
      if (!picked.ok) {
        dispatch({ type: 'screen/set', screen: 'ready' });
        if (picked.kind === 'unsupported') {
          dispatch({ type: 'export-error/set', error: { kind: 'unsupported', reason: 'Saving a file isn’t supported in this browser.' } });
        }
        // 'cancelled' (the user dismissed the picker): not an error, nothing else has started.
        return;
      }

      const selectedTrackIds = selectedRealTrackIds(opts.tracks, opts.sel);
      const client = new ExportWorkerClient();
      clientRef.current = client;

      let sawFinalising = false;
      const result = await client.export(
        {
          file,
          fileHandle: picked.handle,
          tracks: sampleIndex.tracks(),
          selectedTrackIds,
          requestedInSec: opts.tin,
          requestedOutSec: opts.tout,
        },
        (progress) => {
          dispatch({ type: 'export/progress', pct: progress.percent });
          if (progress.phase === 'finalising' && !sawFinalising) {
            sawFinalising = true;
            dispatch({ type: 'screen/set', screen: 'finalising' });
          }
        },
      );

      client.terminate();
      clientRef.current = null;
      dispatch({ type: 'screen/set', screen: 'ready' });

      if (result.ok) {
        // File System Access deliberately never exposes a real filesystem path -- the file
        // handle's own `name` (whatever the user actually confirmed in the Save dialog) is the
        // most specific thing available.
        setLastResult({ outPath: picked.handle.name, durationLabel: formatDurationLabel(result.wallMs) });
        dispatch({ type: 'toast/set', show: true });
        return;
      }

      // A user-initiated cancel is not a failure -- no error toast, matching the overlay's own
      // Cancel button UX.
      if (result.error.kind !== 'cancelled') {
        dispatch({ type: 'export-error/set', error: result.error });
      }
    },
    [dispatch, media],
  );

  const cancelExport = useCallback(() => {
    clientRef.current?.cancel();
  }, []);

  return { startExport, cancelExport, lastResult };
}
