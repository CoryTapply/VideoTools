// Owns the parts of "run a real export" that are resource-shaped, not reducer-shaped: the live
// ExportWorkerClient for the in-flight attempt and the completed result's display fields --
// mirroring media-session.ts's useMediaSession split. app-state.ts still owns
// screen/exportPct/toast/exportError; this hook dispatches into it at the right points.

import { useCallback, useRef, useState } from 'react';
// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { pickExportFile } from '../../media/export/picker.ts';
import { ExportWorkerClient } from '../../media/export/worker-client.ts';
import { defaultExportFileName, selectedRealTrackIds } from '../media/derive-source-info.ts';
import { formatDurationCompact } from './snap-notice.ts';
import type { Dispatch } from 'react';
import type { TrackSelection } from './app-state.ts';
import type { MediaSession } from './media-session.ts';
import type { TrackSummary } from '../media/track-summary.ts';
import type { AppAction } from './app-state.ts';

export interface ExportSessionResult {
  outPath: string;
  durationLabel: string;
}

/** The most recent export attempt's identity/outcome -- see the Jobs panel's
 * derive-source-info.ts's deriveJobsRows. A single value, not a history: nothing in this hook
 * retains earlier attempts once a new one starts. */
export type ExportJobMeta =
  | { fileName: string; status: 'running' }
  | { fileName: string; status: 'done'; durationLabel: string }
  | { fileName: string; status: 'canceled' }
  | { fileName: string; status: 'failed' };

export interface StartExportOptions {
  tstart: number;
  tend: number;
  sel: TrackSelection;
  tracks: readonly TrackSummary[];
  sourceFileName: string;
}

export interface ExportSession {
  startExport: (opts: StartExportOptions) => Promise<void>;
  cancelExport: () => void;
  lastResult: ExportSessionResult | null;
  job: ExportJobMeta | null;
}

export function useExportSession(dispatch: Dispatch<AppAction>, media: MediaSession): ExportSession {
  const clientRef = useRef<ExportWorkerClient | null>(null);
  const [lastResult, setLastResult] = useState<ExportSessionResult | null>(null);
  const [job, setJob] = useState<ExportJobMeta | null>(null);

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

      setJob({ fileName: picked.handle.name, status: 'running' });

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
          requestedStartSec: opts.tstart,
          requestedEndSec: opts.tend,
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
        const durationLabel = formatDurationCompact(result.wallMs / 1000);
        setLastResult({ outPath: picked.handle.name, durationLabel });
        setJob({ fileName: picked.handle.name, status: 'done', durationLabel });
        dispatch({ type: 'toast/set', show: true });
        return;
      }

      // A user-initiated cancel is not a failure -- no error toast, matching the overlay's own
      // Cancel button UX.
      if (result.error.kind === 'cancelled') {
        setJob({ fileName: picked.handle.name, status: 'canceled' });
      } else {
        dispatch({ type: 'export-error/set', error: result.error });
        setJob({ fileName: picked.handle.name, status: 'failed' });
      }
    },
    [dispatch, media],
  );

  const cancelExport = useCallback(() => {
    clientRef.current?.cancel();
  }, []);

  return { startExport, cancelExport, lastResult, job };
}
