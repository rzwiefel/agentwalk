import { memo } from 'react';
import type {
  AnalysisView,
  CodeEdge,
  CodeNode,
  ConnectionMode,
  NodeVisibilityMode,
  NodeVisibilityModes,
  ParserCapabilities,
  ParserDiagnostic,
  RepositoryAnalysisMode,
  RepositoryInfo,
} from '../types';
import type { ActivityConnection, ActivityMode } from '../activity/types';
import type { ActivityLayerToggles } from '../viewSettings';

interface ControlPanelProps {
  viewMode: ActivityMode;
  onViewMode: (mode: ActivityMode) => void;
  activityConnection: ActivityConnection;
  repositoryPath: string;
  repository: RepositoryInfo | null;
  repositoryLoading: boolean;
  onRepositoryPath: (value: string) => void;
  onLoadRepository: () => void;
  analysisMode: RepositoryAnalysisMode;
  onAnalysisMode: (value: RepositoryAnalysisMode) => void;
  parserCapabilities: ParserCapabilities | null;
  parserCapabilitiesLoading: boolean;
  parserAnalysisLoading: boolean;
  parserDiagnostics: ParserDiagnostic[];
  activeLanguage: string | null;
  activeSource: string | null;
  analysisStatus: string | null;
  historySource: 'clojure' | 'parser' | null;
  revision?: import('../types').RevisionMetadata | null;
  search: string;
  onSearch: (value: string) => void;
  visibleKinds: Set<CodeNode['kind']>;
  onToggleKind: (kind: CodeNode['kind']) => void;
  visibilityModes: NodeVisibilityModes;
  onVisibilityMode: (kind: keyof NodeVisibilityModes, mode: NodeVisibilityMode) => void;
  showExternal: boolean;
  onShowExternal: (value: boolean) => void;
  showTestNamespaces: boolean;
  onShowTestNamespaces: (value: boolean) => void;
  showGlobalNamespace: boolean;
  onShowGlobalNamespace: (value: boolean) => void;
  orbitGlobalNamespace: boolean;
  onOrbitGlobalNamespace: (value: boolean) => void;
  showTopLevelFolderConnections: boolean;
  onShowTopLevelFolderConnections: (value: boolean) => void;
  edgeVisibility: Record<CodeEdge['kind'], boolean>;
  onToggleEdge: (kind: CodeEdge['kind']) => void;
  relationshipVisibilityMode: NodeVisibilityMode;
  onRelationshipVisibilityMode: (mode: NodeVisibilityMode) => void;
  showLabels: boolean;
  onShowLabels: (value: boolean) => void;
  nodeScale: number;
  onNodeScale: (value: number) => void;
  onImport: () => void;
  onReset: () => void;
  showHierarchy: boolean;
  onShowHierarchy: (value: boolean) => void;
  hierarchyLeavesOnly: boolean;
  onHierarchyLeavesOnly: (value: boolean) => void;
  heatEnabled: boolean;
  onHeatEnabled: (value: boolean) => void;
  fullOpacity: boolean;
  onFullOpacity: (value: boolean) => void;
  connectionMode: ConnectionMode;
  onConnectionMode: (value: ConnectionMode) => void;
  analysisView: AnalysisView;
  onAnalysisView: (value: AnalysisView) => void;
  physicsEnabled: boolean;
  onPhysicsEnabled: (value: boolean) => void;
  activityLayers: ActivityLayerToggles;
  onToggleActivityLayer: (key: keyof ActivityLayerToggles) => void;
  activityPaused: boolean;
  onToggleActivityPaused: () => void;
  onClearActivity: () => void;
  /** T1-G: dim non-selected sessions instead of removing them from the canvas. */
  activityDimOthers: boolean;
  onToggleActivityDimOthers: () => void;
  showInactiveAgents: boolean;
  onShowInactiveAgents: (value: boolean) => void;
}

const kindLabels: Array<[CodeNode['kind'], string]> = [['namespace', 'Namespaces'], ['var', 'Vars'], ['keyword', 'Keywords']];
const dynamicKindLabels: Array<[keyof NodeVisibilityModes, string]> = [['var', 'Vars'], ['keyword', 'Keywords']];
const edgeLabels: Array<[CodeEdge['kind'], string]> = [['requires', 'Requires'], ['calls', 'Calls'], ['mentions', 'Mentions']];
const activityLayerLabels: Array<[keyof ActivityLayerToggles, string]> = [
  ['rays', 'Rays'],
  ['pulses', 'Pulses'],
  ['snippetMarkers', 'Snippet markers'],
  ['filePlane', 'File plane'],
  ['toolbox', 'Toolbox'],
];
const analysisModeLabels: Array<[RepositoryAnalysisMode, string]> = [
  ['clojure', 'Clojure (live Git history)'],
  ['auto', 'Auto-detect parser'],
  ['python', 'Python'],
  ['csharp', 'C#'],
  ['typescript-javascript', 'TypeScript / JavaScript'],
];

function parserDisplayName(name: string) {
  return name === 'typescript-javascript' ? 'TypeScript/JavaScript' : name === 'csharp' ? 'C#' : name;
}

function capabilityMessage(capability: NonNullable<ParserCapabilities['adapters']>[number]) {
  if (capability.available === false || capability.adapterAvailable === false || capability.runtimeAvailable === false || capability.missingRuntime === true) {
    return `Unavailable${capability.message ? `: ${capability.message}` : capability.runtime ? `; install ${capability.runtime}` : ''}`;
  }
  if (capability.status && /unavailable|missing|error|fail/i.test(capability.status)) {
    return capability.message ?? capability.reason ?? capability.status;
  }
  return capability.runtime ? `Runtime: ${capability.runtime}` : capability.message ?? null;
}

export function architectureControlsVisible(viewMode: ActivityMode): boolean {
  return viewMode === 'architecture';
}

export const ControlPanel = memo(function ControlPanel(props: ControlPanelProps) {
  const showArchitectureControls = architectureControlsVisible(props.viewMode);
  return (
    <aside className="control-panel">
      <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><h1>AGENTWALK</h1><p>structural navigation</p></div></div>
      <section className="mode-switch" aria-label="Visualization mode">
        <span className="eyebrow">Visualization mode</span>
        <div className="mode-switch-buttons">
          <button type="button" className={props.viewMode === 'activity' ? 'mode-button active' : 'mode-button'} aria-pressed={props.viewMode === 'activity'} onClick={() => props.onViewMode('activity')}>Live Activity</button>
          <button type="button" className={props.viewMode === 'architecture' ? 'mode-button active' : 'mode-button'} aria-pressed={props.viewMode === 'architecture'} onClick={() => props.onViewMode('architecture')}>Architecture</button>
        </div>
        {props.viewMode === 'activity' && <p className="activity-mode-note">All workspace sessions are included. The static graph layout is preserved; only explicitly reported events matching it pulse code nodes. <strong>{props.activityConnection.status}</strong></p>}
      </section>
      {showArchitectureControls && <label className="search-box"><span>/</span><input autoFocus={false} value={props.search} onChange={event => props.onSearch(event.target.value)} placeholder="Search namespaces and vars" /><kbd>esc</kbd></label>}
      {showArchitectureControls && <section className="repository-picker">
        <span className="eyebrow">Repository analysis</span>
        <label className="analysis-mode-label" htmlFor="analysis-mode">Mode</label>
        <select id="analysis-mode" className="analysis-mode" value={props.analysisMode} onChange={event => {
          const mode = event.target.value;
          if (analysisModeLabels.some(([value]) => value === mode)) props.onAnalysisMode(mode as RepositoryAnalysisMode);
        }}>
          {analysisModeLabels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="analysis-mode-label" htmlFor="repository-path">Path</label>
        <div className="repository-input"><input id="repository-path" aria-label="Repository path" value={props.repositoryPath} onChange={event => props.onRepositoryPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') props.onLoadRepository(); }} placeholder="/path/to/repository" /><button disabled={props.repositoryLoading || props.parserCapabilitiesLoading || props.parserAnalysisLoading} onClick={props.onLoadRepository}>{props.repositoryLoading || props.parserAnalysisLoading ? 'Analyzing...' : props.analysisMode === 'clojure' ? 'Load' : 'Analyze'}</button></div>
        {props.repository && <span className="repository-summary">{props.repository.name} / {props.repository.commitCount.toLocaleString()} commits</span>}
        {props.analysisMode === 'clojure'
          ? <p className="repository-help">Uses the live Clojure endpoints; select a commit to analyze that revision on demand.</p>
          : <p className="repository-help">{props.historySource === 'parser' ? 'Git history is available; use the playback controls to analyze revisions on demand.' : 'Checks parser capabilities, then loads the working tree. Git history playback is unavailable outside Git.'}</p>}
        {props.parserCapabilities && (
          <div className="parser-capabilities" aria-live="polite">
            <strong>Detected: {props.parserCapabilities.repository?.candidates?.map(parserDisplayName).join(', ') || 'none'}</strong>
            {props.parserCapabilities.repository?.ambiguous && <span className="analysis-warning">Auto-detection is ambiguous; choose a language.</span>}
            {props.parserCapabilities.repository?.reason && <span>{props.parserCapabilities.repository.reason}</span>}
            {props.parserCapabilities.adapters?.map(adapter => {
              const message = capabilityMessage(adapter);
              return <span key={adapter.name} className={adapter.available === false || adapter.adapterAvailable === false || adapter.runtimeAvailable === false || adapter.missingRuntime === true ? 'capability-unavailable' : ''}>{adapter.displayName ?? parserDisplayName(adapter.name)}{adapter.detected ? ' detected' : ''}{message ? ` · ${message}` : ''}</span>;
            })}
          </div>
        )}
        {props.parserCapabilitiesLoading && <p className="repository-help" role="status">Checking parser capabilities...</p>}
        {props.analysisStatus && <p className="parser-status" role="status">Active: {props.activeLanguage ?? 'unknown'} / {props.activeSource ?? props.repositoryPath} · {props.analysisStatus}{props.revision ? ` · ${props.revision.mode}` : ''}</p>}
        {props.parserDiagnostics.length > 0 && (
          <details className="parser-diagnostics">
            <summary>{props.parserDiagnostics.length} parser diagnostic{props.parserDiagnostics.length === 1 ? '' : 's'}</summary>
            <ul>{props.parserDiagnostics.slice(0, 12).map((diagnostic, index) => <li key={diagnostic.id ?? `${diagnostic.code ?? 'diagnostic'}-${index}`}><strong>{diagnostic.severity ?? 'notice'}</strong> {diagnostic.message}{diagnostic.file ? ` (${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''})` : ''}</li>)}</ul>
          </details>
        )}
      </section>}
      <div className="panel-actions">{showArchitectureControls && <button onClick={props.onImport}>Import graph JSON</button>}<button className="icon-button" onClick={props.onReset} title="Reset camera">Reset view</button></div>
{props.viewMode === 'architecture' && (
<section className="control-section">
  <span className="eyebrow">Visible nodes</span>
  <div className="toggle-grid">{kindLabels.map(([kind, label]) => <button key={kind} className={props.visibleKinds.has(kind) ? 'toggle active' : 'toggle'} onClick={() => props.onToggleKind(kind)}><span className={`kind-dot kind-${kind}`} />{label}</button>)}</div>
  <div className="visibility-modes">
    {dynamicKindLabels.map(([kind, label]) => <label className="visibility-mode-row" key={kind}><span>{label}</span><select value={props.visibilityModes[kind]} onChange={event => { const mode = event.target.value; if (mode === 'always' || mode === 'updated') props.onVisibilityMode(kind, mode); }}><option value="always">Always</option><option value="updated">Updated only</option></select></label>)}
  </div>
  <label className="check-row"><input type="checkbox" checked={props.showExternal} onChange={event => props.onShowExternal(event.target.checked)} /> Show library references</label><label className="check-row"><input type="checkbox" checked={props.showTestNamespaces} onChange={event => props.onShowTestNamespaces(event.target.checked)} /> Show test namespaces</label><label className="check-row"><input type="checkbox" checked={props.showGlobalNamespace} onChange={event => props.onShowGlobalNamespace(event.target.checked)} /> Show global / unscoped nodes</label><label className="check-row global-placement-row"><input id="orbit-global-namespace" aria-label="Orbit global / unscoped nodes" type="checkbox" checked={props.orbitGlobalNamespace} onChange={event => props.onOrbitGlobalNamespace(event.target.checked)} /> Orbit global / unscoped nodes</label>
</section>
      )}
      {props.viewMode === 'architecture' && <section className="control-section"><span className="eyebrow">Relationships</span><div className="toggle-grid">{edgeLabels.map(([kind, label]) => <button key={kind} className={props.edgeVisibility[kind] ? 'toggle active' : 'toggle'} onClick={() => props.onToggleEdge(kind)}><span className={`edge-line edge-${kind}`} />{label}</button>)}</div><label className="visibility-mode-row relationship-mode-row"><span>Visibility</span><select value={props.relationshipVisibilityMode} onChange={event => { const mode = event.target.value; if (mode === 'always' || mode === 'updated') props.onRelationshipVisibilityMode(mode); }}><option value="always">Always</option><option value="updated">Updated only</option></select></label><label className="check-row"><input type="checkbox" checked={props.showTopLevelFolderConnections} onChange={event => props.onShowTopLevelFolderConnections(event.target.checked)} /> Show top-level folder connections</label></section>}
      <section className="control-section"><span className="eyebrow">View</span><label className="check-row"><input type="checkbox" checked={props.showLabels} onChange={event => props.onShowLabels(event.target.checked)} /> Show all labels</label><label className="check-row"><input type="checkbox" checked={props.showHierarchy} onChange={event => props.onShowHierarchy(event.target.checked)} /> Show hierarchy volumes</label><label className="check-row"><input type="checkbox" checked={props.hierarchyLeavesOnly} onChange={event => props.onHierarchyLeavesOnly(event.target.checked)} /> Leaf hierarchy volumes only</label>{props.viewMode === 'architecture' && <><label className="check-row"><input type="checkbox" checked={props.heatEnabled} onChange={event => props.onHeatEnabled(event.target.checked)} /> Edit heat</label><label className="check-row"><input type="checkbox" checked={props.fullOpacity} onChange={event => props.onFullOpacity(event.target.checked)} /> Full opacity / static view</label><label className="visibility-mode-row"><span>Connection analysis</span><select value={props.connectionMode} onChange={event => { const mode = event.target.value; if (mode === 'off' || mode === 'connected' || mode === 'overdependency') props.onConnectionMode(mode); }}><option value="off">Off</option><option value="connected">Most connected</option><option value="overdependency">Overdependency risk</option></select></label><label className="visibility-mode-row"><span>Analysis panel</span><select value={props.analysisView} onChange={event => { const view = event.target.value; if (view === 'dossier' || view === 'blast-radius' || view === 'temporal' || view === 'communities' || view === 'dsm') props.onAnalysisView(view); }}><option value="dossier">Namespace dossier</option><option value="blast-radius">Blast radius</option><option value="temporal">Temporal coupling</option><option value="communities">Communities</option><option value="dsm">Dependency matrix</option></select></label><label className="check-row"><input type="checkbox" checked={props.physicsEnabled} onChange={event => props.onPhysicsEnabled(event.target.checked)} /> Local gravity physics</label></>}{showArchitectureControls && <label className="range-row"><span>Node scale</span><input type="range" min="0.6" max="1.8" step="0.1" value={props.nodeScale} onChange={event => props.onNodeScale(Number(event.target.value))} /></label>}</section>
      {props.viewMode === 'activity' && (
        <section className="control-section activity-section">
          <span className="eyebrow">Activity</span>
          <div className="toggle-grid">{activityLayerLabels.map(([key, label]) => <button key={key} className={props.activityLayers[key] ? 'toggle active' : 'toggle'} onClick={() => props.onToggleActivityLayer(key)}>{label}</button>)}</div>
          <label className="check-row"><input type="checkbox" aria-label="Show inactive agents" checked={props.showInactiveAgents} onChange={event => props.onShowInactiveAgents(event.target.checked)} /> Show inactive agents</label>
          <label className="check-row"><input type="checkbox" checked={props.activityDimOthers} onChange={props.onToggleActivityDimOthers} /> Dim non-selected sessions instead of hiding them</label>
          <div className="panel-actions activity-stream-actions">
            <button className={props.activityPaused ? 'is-active' : undefined} onClick={props.onToggleActivityPaused} title="Stop applying new stream events until resumed">{props.activityPaused ? 'Resume stream' : 'Pause stream'}</button>
            <button onClick={props.onClearActivity} title="Reset the live activity view">Clear</button>
          </div>
          <p className="activity-mode-note">Click an agent to follow it, click again (or empty space) to release. Press <kbd>1</kbd>-<kbd>9</kbd> to solo a session, <kbd>0</kbd> or <kbd>esc</kbd> to clear.</p>
        </section>
      )}
      <div className="shortcuts"><span className="eyebrow">Shortcuts</span><p>{showArchitectureControls && <><kbd>/</kbd> Search </>}<kbd>esc</kbd> Clear <kbd>w/s</kbd> Move <kbd>double click</kbd> Focus</p></div>
    </aside>
  );
});
