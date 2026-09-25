import { memo } from 'react';
import type { HistoryCommit, RevisionMetadata } from '../types';

interface HistoryControlsProps {
  loading?: boolean;
  liveMode?: boolean;
  loadedCommitHash?: string | null;
  commits: HistoryCommit[];
  index: number;
  playing: boolean;
  intervalMs: number;
  revision?: RevisionMetadata | null;
  historyExplanation?: string | null;
  error?: string | null;
  onRetry?: () => void;
  onTogglePlaying: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onJumpBack: (amount: number) => void;
  onIndex: (index: number) => void;
  onInterval: (intervalMs: number) => void;
}

export const HistoryControls = memo(function HistoryControls({ loading = false, liveMode = false, loadedCommitHash = null, commits, index, playing, intervalMs, revision = null, historyExplanation = null, error = null, onRetry, onTogglePlaying, onPrevious, onNext, onJumpBack, onIndex, onInterval }: HistoryControlsProps) {
  if (commits.length === 0) {
    return historyExplanation ? <div className="history-controls history-static" role="status"><span className="eyebrow">Git history playback</span><p>{historyExplanation}</p></div> : null;
  }
  const active = index >= 0 ? commits[index] : undefined;
  return (
    <div className="history-controls" aria-busy={loading}>
      <div className="history-heading">
        <span className="eyebrow">Git history playback</span>
        <span className="history-count">{loading ? 'Loading snapshot...' : `${index >= 0 ? index + 1 : 0} / ${commits.length}`}</span>
      </div>
      <div className="history-row">
        <button className="history-step" onClick={onPrevious} title="Previous commit">Previous</button><button className="history-play" onClick={onTogglePlaying}>{playing ? 'Pause' : 'Play history'}</button><button className="history-step" onClick={onNext} title="Next commit">Next</button>
        <input className="history-scrubber" type="range" min="0" max={commits.length - 1} value={Math.max(0, index)} onChange={event => onIndex(Number(event.target.value))} />
        <label className="history-speed">Interval <input type="range" min="0" max="10000" step="250" value={intervalMs} onChange={event => onInterval(Number(event.target.value))} /><span>{intervalMs === 0 ? 'fastest' : `${intervalMs / 1000}s`}</span></label>
      </div>
      <div className="history-bottom">
        <div className="history-commit">
          {active ? <><code>{active.shortHash}</code><strong>{active.message}</strong><span>{new Date(active.timestamp).toLocaleDateString()} / {liveMode && active.hash !== loadedCommitHash ? 'pending analysis' : `${active.changedNodeIds.length} nodes`} / {active.changedFiles?.length ?? 0} files</span></> : <span>Press play or choose a commit to begin</span>}
        </div>
        <div className="history-jumps"><button className="history-jump" disabled={loading || index <= 0} onClick={() => onJumpBack(10)}>back 10</button><button className="history-jump" disabled={loading || index <= 0} onClick={() => onJumpBack(100)}>back 100</button></div>
      </div>
      {revision && <div className="history-revision" role="status"><strong>{revision.mode}</strong><span>{revision.mode === 'full' ? 'Full adapter reparse (higher cost)' : revision.mode === 'cached' ? 'Cached fully parsed snapshot' : 'Full adapter reparse with incremental change mapping'}</span>{revision.limitations.length > 0 && <details><summary>Limitations</summary><ul>{revision.limitations.map((limitation, index) => <li key={`${limitation}-${index}`}>{limitation}</li>)}</ul></details>}</div>}
      {error && onRetry && <div className="history-error" role="alert"><span>Revision unavailable. The previous graph is still shown.</span><button onClick={onRetry}>Retry</button></div>}
    </div>
  );
});
