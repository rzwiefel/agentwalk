import { useMemo, useState, type CSSProperties } from 'react';
import type { CodeGraph, EdgeKind } from '../types';
import {
  analyzeBlastRadius,
  normalizeBlastRadiusOptions,
  type BlastRadiusDirection,
  type BlastRadiusOptions,
  type BlastRadiusResult,
  type BlastRadiusScope,
} from '../blastRadius';

export interface BlastRadiusPanelProps {
  graph: CodeGraph;
  root?: string | null;
  options?: Partial<BlastRadiusOptions>;
  onRootChange?: (root: string | null) => void;
  onOptionsChange?: (options: BlastRadiusOptions) => void;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  className?: string;
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: '#aebde0',
  fontSize: 11,
};

const controlStyle: CSSProperties = {
  width: '100%',
  border: '1px solid rgba(147, 169, 224, .18)',
  borderRadius: 4,
  padding: '5px 6px',
  color: '#b9c8f4',
  background: '#151f36',
  fontSize: 10,
};

function nodeLabel(graph: CodeGraph, nodeId: string): string {
  return graph.nodes.find(node => node.id === nodeId)?.label ?? nodeId;
}

function resultSummary(result: BlastRadiusResult): string {
  if (!result.root) return 'Choose a root node to trace structural reachability.';
  if (result.rootNodeIds.length === 0) return 'The selected root is not present in this graph.';
  return `${result.affectedNodeIds.length} node${result.affectedNodeIds.length === 1 ? '' : 's'} / ${result.affectedNamespaceIds.length} namespace${result.affectedNamespaceIds.length === 1 ? '' : 's'}`;
}

export function BlastRadiusPanel(props: BlastRadiusPanelProps) {
  const [localRoot, setLocalRoot] = useState<string | null>(props.root ?? null);
  const [localOptions, setLocalOptions] = useState<Partial<BlastRadiusOptions>>({});
  const root = props.root === undefined ? localRoot : props.root;
  const options = normalizeBlastRadiusOptions({ ...localOptions, ...props.options });
  const result = useMemo(
    () => analyzeBlastRadius(props.graph, root, options),
    [props.graph, root, options.direction, options.relationKinds.join(','), options.includeMentions, options.maxDepth, options.maxPaths, options.scope],
  );
  const roots = props.graph.nodes
    .slice()
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  const updateRoot = (nextRoot: string | null) => {
    setLocalRoot(nextRoot);
    props.onRootChange?.(nextRoot);
  };
  const updateOptions = (patch: Partial<BlastRadiusOptions>) => {
    const nextOptions = normalizeBlastRadiusOptions({ ...options, ...patch });
    setLocalOptions(nextOptions);
    props.onOptionsChange?.(nextOptions);
  };

  return (
    <section className={props.className ?? 'blast-radius-panel'} style={panelStyle}>
      <div>
        <span className="eyebrow">Blast radius</span>
        <h2 style={{ margin: '5px 0 0', color: '#edf2ff', fontSize: 17, letterSpacing: '-.03em' }}>Structural reachability</h2>
        <p style={{ color: '#7585a8', lineHeight: 1.5, margin: '8px 0 0' }}>Traverses graph relationships; it does not predict causal impact.</p>
      </div>
      <label>
        <span className="eyebrow">Root</span>
        <select aria-label="Blast radius root" style={{ ...controlStyle, marginTop: 7 }} value={root ?? ''} onChange={event => updateRoot(event.target.value || null)}>
          <option value="">Select a node</option>
          {roots.map(node => <option key={node.id} value={node.id}>{node.label} · {node.kind}</option>)}
        </select>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label>
          <span className="eyebrow">Direction</span>
          <select aria-label="Blast radius direction" style={{ ...controlStyle, marginTop: 7 }} value={options.direction} onChange={event => updateOptions({ direction: event.target.value as BlastRadiusDirection })}>
            <option value="both">Both</option>
            <option value="reverse">Dependents</option>
            <option value="forward">Dependencies</option>
          </select>
        </label>
        <label>
          <span className="eyebrow">Scope</span>
          <select aria-label="Blast radius scope" style={{ ...controlStyle, marginTop: 7 }} value={options.scope} onChange={event => updateOptions({ scope: event.target.value as BlastRadiusScope })}>
            <option value="internal">Internal</option>
            <option value="external">External</option>
            <option value="all">All nodes</option>
          </select>
        </label>
      </div>
      <label>
        <span className="eyebrow">Relations</span>
        <select
          aria-label="Blast radius relation filter"
          style={{ ...controlStyle, marginTop: 7 }}
          value={options.relationKinds.filter(kind => kind !== 'mentions').join(',')}
          onChange={event => {
            const relation = event.target.value as Extract<EdgeKind, 'requires' | 'calls'>;
            updateOptions({ relationKinds: relation ? [relation] : [] });
          }}
        >
          <option value="requires">Requires</option>
          <option value="calls">Calls</option>
          <option value="">No structural relations</option>
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#8795b4' }}>
        <input type="checkbox" checked={options.includeMentions} onChange={event => updateOptions({ includeMentions: event.target.checked })} />
        Include mentions (nonstructural)
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label>
          <span className="eyebrow">Max depth</span>
          <input aria-label="Blast radius maximum depth" style={{ ...controlStyle, marginTop: 7 }} type="number" min={0} max={20} value={options.maxDepth} onChange={event => updateOptions({ maxDepth: Number(event.target.value) })} />
        </label>
        <label>
          <span className="eyebrow">Max paths</span>
          <input aria-label="Blast radius maximum paths" style={{ ...controlStyle, marginTop: 7 }} type="number" min={0} max={1000} value={options.maxPaths} onChange={event => updateOptions({ maxPaths: Number(event.target.value) })} />
        </label>
      </div>
      <div style={{ borderTop: '1px solid rgba(147, 169, 224, .1)', paddingTop: 12 }}>
        <span className="eyebrow">Result</span>
        <strong style={{ display: 'block', color: '#edf2ff', marginTop: 6 }}>{resultSummary(result)}</strong>
        {result.rootNodeIds.length > 0 && <small style={{ display: 'block', color: '#7182a3', marginTop: 5 }}>Root: {result.rootNodeIds.map(nodeId => nodeLabel(props.graph, nodeId)).join(', ')}</small>}
        {result.bounds.truncated && <small style={{ display: 'block', color: '#ffd166', marginTop: 6 }}>Bounded result: {result.bounds.depthTruncated ? 'depth' : 'path count'} limit reached.</small>}
      </div>
      {result.affectedNamespaceIds.length > 0 && (
        <div>
          <span className="eyebrow">Affected namespaces</span>
          <div style={{ display: 'grid', gap: 4, marginTop: 7 }}>
            {result.affectedNamespaceIds.map(nodeId => <button key={nodeId} type="button" onClick={() => props.onSelectNode?.(nodeId)} style={{ border: 0, padding: '5px 6px', textAlign: 'left', borderRadius: 4, color: '#9fb3ed', background: 'rgba(120, 152, 255, .08)', fontSize: 10 }}>{nodeLabel(props.graph, nodeId)} <span style={{ color: '#7182a3' }}>· {result.shortestDistance[nodeId] ?? '—'} hops</span></button>)}
          </div>
        </div>
      )}
      {result.paths.length > 0 && (
        <div>
          <span className="eyebrow">Representative paths</span>
          <div style={{ display: 'grid', gap: 5, marginTop: 7 }}>
            {result.paths.map(path => <button key={`${path.direction}:${path.edgeIds.join(',')}`} type="button" onClick={() => path.edgeIds.forEach(edgeId => props.onSelectEdge?.(edgeId))} style={{ border: '1px solid rgba(147, 169, 224, .12)', borderRadius: 4, padding: 6, textAlign: 'left', color: '#9aa9c8', background: 'rgba(147, 169, 224, .05)', font: '9px "DM Mono", monospace' }} title={path.edgeIds.join(' → ')}>{path.direction} · {path.nodeIds.map(nodeId => nodeLabel(props.graph, nodeId)).join(' → ')}</button>)}
          </div>
        </div>
      )}
      <small style={{ color: '#52617e', lineHeight: 1.5 }}>{result.sourceEvidenceReferences.length} source-evidence reference{result.sourceEvidenceReferences.length === 1 ? '' : 's'} · {result.bounds.pathsReturned}/{result.bounds.maxPaths} paths</small>
    </section>
  );
}

export default BlastRadiusPanel;
