import { useMemo } from 'react';
import { buildCommunityAnalysis } from '../architectureViews';
import type { CommunityAnalysis } from '../architectureViews';
import type { CodeGraph } from '../types';

export interface CommunityViewProps {
  graph?: CodeGraph;
  analysis?: CommunityAnalysis;
  selectedCommunityId?: string | null;
  selectedNamespace?: string | null;
  onSelectCommunity?: (communityId: string) => void;
  onSelectNamespace?: (namespace: string) => void;
  onSelectEdge?: (edgeIds: string[]) => void;
  maxCommunities?: number;
  maxMembersPerCommunity?: number;
}

const panelStyle: React.CSSProperties = {
  color: '#dce6ff',
  background: 'rgba(10, 15, 28, .94)',
  border: '1px solid rgba(147, 169, 224, .16)',
  borderRadius: 8,
  padding: 14,
  fontSize: 11,
  lineHeight: 1.4,
  overflow: 'auto',
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function CommunityView({
  graph,
  analysis,
  selectedCommunityId = null,
  selectedNamespace = null,
  onSelectCommunity,
  onSelectNamespace,
  onSelectEdge,
  maxCommunities = 32,
  maxMembersPerCommunity = 18,
}: CommunityViewProps) {
  const model = useMemo(() => analysis ?? (graph ? buildCommunityAnalysis(graph) : null), [analysis, graph]);
  if (!model) return <section style={panelStyle}>Load a graph to inspect communities.</section>;

  const visibleCommunities = model.communities.slice(0, maxCommunities);
  return (
    <section style={panelStyle} aria-label="Community architecture view">
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <span style={{ color: '#6f80a5', font: '10px DM Mono, monospace', letterSpacing: '.1em', textTransform: 'uppercase' }}>Architecture / communities</span>
          <h2 style={{ margin: '4px 0 0', fontSize: 16 }}>Dependency communities</h2>
        </div>
        <code style={{ color: '#8ea5e6', fontSize: 10 }}>{model.projection.namespaces.length} namespaces · {model.communities.length} clusters</code>
      </header>
      <p style={{ color: '#8ea5e6', margin: '0 0 10px', font: '10px DM Mono, monospace' }}>
        Selected namespace: {selectedNamespace ?? 'none'}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {visibleCommunities.map(community => {
          const members = community.members.slice(0, maxMembersPerCommunity);
          const drift = model.driftCandidates.filter(candidate => candidate.communityId === community.id);
          const containsSelection = selectedNamespace !== null && community.members.includes(selectedNamespace);
          return (
            <article key={community.id} style={{ border: `1px solid ${selectedCommunityId === community.id || containsSelection ? '#7898ff' : 'rgba(147, 169, 224, .12)'}`, borderRadius: 6, padding: 9, background: containsSelection ? 'rgba(120, 152, 255, .1)' : 'rgba(30, 43, 73, .18)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <button type="button" onClick={() => onSelectCommunity?.(community.id)} aria-pressed={selectedCommunityId === community.id} style={{ border: 0, padding: 0, color: '#edf2ff', background: 'transparent', overflowWrap: 'anywhere', cursor: onSelectCommunity ? 'pointer' : 'default', fontWeight: 700, textAlign: 'left' }}>{community.label || 'root'}</button>
                <span style={{ color: community.boundaryStrength > .55 ? '#ffb347' : '#76ddc0', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>
                  boundary {percent(community.boundaryStrength)}
                </span>
              </div>
              {community.edgeIds.length > 0 && <button type="button" onClick={() => onSelectEdge?.(community.edgeIds)} style={{ marginTop: 7, border: 0, padding: 0, color: '#7898ff', background: 'transparent', cursor: onSelectEdge ? 'pointer' : 'default', font: '10px DM Mono, monospace' }}>{community.edgeIds.length} evidence-linked edge IDs</button>}
              <div style={{ color: '#7182a3', font: '10px DM Mono, monospace', marginTop: 3 }}>
                {community.members.length} members · internal {community.internalWeight} · boundary {community.boundaryWeight}
                {drift.length > 0 && ` · ${drift.length} hierarchy drift${drift.length === 1 ? '' : 's'}`}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                {members.map(namespace => (
                  <button
                    key={namespace}
                    type="button"
                    onClick={() => onSelectNamespace?.(namespace)}
                    style={{
                      border: `1px solid ${selectedNamespace === namespace ? '#7898ff' : 'rgba(147, 169, 224, .18)'}`,
                      borderRadius: 4,
                      padding: '3px 5px',
                      color: selectedNamespace === namespace ? '#edf2ff' : '#9aa9c8',
                      background: selectedNamespace === namespace ? 'rgba(120, 152, 255, .18)' : 'transparent',
                      cursor: onSelectNamespace ? 'pointer' : 'default',
                      font: '10px DM Mono, monospace',
                    }}
                  >
                    {namespace}
                  </button>
                ))}
                {community.members.length > members.length && <span style={{ color: '#637293', padding: '3px 4px', font: '10px DM Mono, monospace' }}>+{community.members.length - members.length}</span>}
              </div>
              {drift.length > 0 && (
                <div style={{ marginTop: 7, color: '#ffcc88', fontSize: 10 }}>
                  Drift: {drift.slice(0, 3).map(candidate => candidate.namespace).join(', ')}
                  {drift.length > 3 ? ` +${drift.length - 3}` : ''}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {model.communities.length > visibleCommunities.length && <p style={{ color: '#7182a3', font: '10px DM Mono, monospace' }}>Showing {visibleCommunities.length} of {model.communities.length} clusters.</p>}
      <details style={{ marginTop: 12, color: '#7182a3' }}>
        <summary style={{ cursor: 'pointer', color: '#8ea5e6' }}>Method and limitations</summary>
        <ul style={{ margin: '7px 0 0', paddingLeft: 18 }}>
          {model.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
        </ul>
      </details>
    </section>
  );
}

export default CommunityView;
