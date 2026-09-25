import { useMemo, useState } from 'react';
import { buildDsmModel, relationshipKinds } from '../architectureViews';
import type { DsmCell, DsmModel } from '../architectureViews';
import type { CodeGraph } from '../types';

export interface DsmViewProps {
  graph?: CodeGraph;
  model?: DsmModel;
  selectedCellId?: string | null;
  selectedNamespace?: string | null;
  onSelectCell?: (cell: DsmCell) => void;
  onSelectNamespace?: (namespace: string) => void;
  onSelectEdge?: (edgeIds: string[]) => void;
  maxDimension?: number;
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

export function DsmView({ graph, model, selectedCellId = null, selectedNamespace = null, onSelectCell, onSelectNamespace, onSelectEdge, maxDimension = 36 }: DsmViewProps) {
  const computed = useMemo(() => model ?? (graph ? buildDsmModel(graph) : null), [graph, model]);
  const [localCellId, setLocalCellId] = useState<string | null>(null);
  if (!computed) return <section style={panelStyle}>Load a graph to inspect the dependency matrix.</section>;

  const displayedNamespaces = computed.namespaces.slice(0, maxDimension);
  const displayedIds = new Set(displayedNamespaces.map(item => item.namespace));
  const cells = computed.cells.filter(cell => displayedIds.has(cell.source) && displayedIds.has(cell.target));
  const cellById = new Map(cells.map(cell => [cell.id, cell]));
  const activeCellId = selectedCellId ?? localCellId;
  const activeCell = activeCellId ? computed.cells.find(cell => cell.id === activeCellId) : undefined;
  const maxWeight = cells.reduce((maximum, cell) => Math.max(maximum, cell.weight), 1);

  const select = (cell: DsmCell) => {
    setLocalCellId(cell.id);
    onSelectCell?.(cell);
  };
  return (
    <section style={panelStyle} aria-label="Dependency structure matrix">
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
        <div>
          <span style={{ color: '#6f80a5', font: '10px DM Mono, monospace', letterSpacing: '.1em', textTransform: 'uppercase' }}>Architecture / DSM</span>
          <h2 style={{ margin: '4px 0 0', fontSize: 16 }}>Dependency structure matrix</h2>
        </div>
        <span style={{ color: computed.cycleSignal === 'cyclic' ? '#ff8c98' : '#76ddc0', font: '10px DM Mono, monospace' }}>
          {computed.cycleSignal} · {computed.cells.length} sparse cells
        </span>
      </header>
      <p style={{ color: '#8ea5e6', margin: '0 0 10px', font: '10px DM Mono, monospace' }}>
        Selected namespace: {selectedNamespace ?? 'none'}
      </p>
      <div style={{ overflow: 'auto', maxWidth: '100%' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 2, tableLayout: 'fixed', minWidth: Math.max(440, displayedNamespaces.length * 36 + 150) }}>
          <thead>
            <tr>
              <th style={{ width: 145, position: 'sticky', left: 0, zIndex: 1, background: '#0d1424' }} />
              {displayedNamespaces.map(item => <th key={item.namespace} title={item.namespace} style={{ color: '#8ea5e6', font: '9px DM Mono, monospace', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 112, maxWidth: 30, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><button type="button" onClick={() => onSelectNamespace?.(item.namespace)} style={{ border: 0, color: 'inherit', background: 'transparent', cursor: onSelectNamespace ? 'pointer' : 'default', font: 'inherit' }}>{item.namespace}</button></th>)}
            </tr>
          </thead>
          <tbody>
            {displayedNamespaces.map(row => (
              <tr key={row.namespace}>
                <th title={row.namespace} style={{ color: '#9aa9c8', font: '9px DM Mono, monospace', textAlign: 'right', paddingRight: 6, maxWidth: 145, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#0d1424' }}><button type="button" onClick={() => onSelectNamespace?.(row.namespace)} style={{ border: 0, color: selectedNamespace === row.namespace ? '#edf2ff' : 'inherit', background: 'transparent', cursor: onSelectNamespace ? 'pointer' : 'default', font: 'inherit' }}>{row.namespace}</button></th>
                {displayedNamespaces.map(column => {
                  const cell = cellById.get(`${row.namespace}\u0000${column.namespace}`);
                  const alpha = cell ? 0.13 + (cell.weight / maxWeight) * 0.72 : 0;
                  return (
                    <td key={column.namespace} style={{ width: 30, height: 25, padding: 0, borderTop: row.groupId !== column.groupId ? '1px solid rgba(255, 209, 102, .22)' : undefined, borderLeft: row.groupId !== column.groupId ? '1px solid rgba(255, 209, 102, .22)' : undefined }}>
                      {cell && (
                        <button
                          type="button"
                          title={`${cell.source} → ${cell.target}: ${relationshipKinds(cell.counts)}`}
                          aria-label={`${cell.source} to ${cell.target}, ${relationshipKinds(cell.counts)}`}
                          onClick={() => { select(cell); onSelectNamespace?.(cell.target); onSelectEdge?.(cell.edgeIds); }}
                          style={{ width: '100%', height: '100%', minHeight: 23, border: activeCellId === cell.id ? '1px solid #edf2ff' : '1px solid transparent', borderRadius: 3, color: cell.cyclic ? '#ff8c98' : '#dce6ff', background: `rgba(${cell.direction === 'backward' ? '255, 179, 71' : '120, 152, 255'}, ${alpha})`, padding: 0, cursor: onSelectCell || true ? 'pointer' : 'default', font: '9px DM Mono, monospace' }}
                        >
                          {relationshipKinds(cell.counts)}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {computed.namespaces.length > displayedNamespaces.length && <p style={{ color: '#7182a3', font: '10px DM Mono, monospace' }}>Showing the first {displayedNamespaces.length} of {computed.namespaces.length} namespaces to keep rendering bounded.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
        <span style={{ color: '#7182a3', font: '10px DM Mono, monospace' }}>forward <strong style={{ color: '#8ea5e6' }}>{computed.forwardWeight}</strong></span>
        <span style={{ color: '#7182a3', font: '10px DM Mono, monospace' }}>backward <strong style={{ color: '#ffb347' }}>{computed.backwardWeight}</strong></span>
        <span style={{ color: '#7182a3', font: '10px DM Mono, monospace' }}>cycle nodes <strong style={{ color: '#ff8c98' }}>{computed.cycleNamespaces.length}</strong></span>
      </div>
      <div style={{ marginTop: 10, minHeight: 34, borderTop: '1px solid rgba(147, 169, 224, .1)', paddingTop: 9 }}>
        {activeCell ? (
          <div>
            <strong style={{ color: '#edf2ff', font: '11px DM Mono, monospace' }}>{activeCell.source} → {activeCell.target}</strong>
            <div style={{ color: '#9aa9c8', marginTop: 3 }}>kinds {relationshipKinds(activeCell.counts)} · occurrences {activeCell.occurrenceWeight} · weighted {activeCell.weight} · edges {activeCell.edgeIds.join(', ') || 'none'} · evidence {activeCell.evidence.length}{activeCell.cyclic ? ' · cycle member' : ''}</div>
          </div>
        ) : <span style={{ color: '#7182a3' }}>Select a matrix cell for relationship-kind counts and edge IDs.</span>}
      </div>
      <details style={{ marginTop: 10, color: '#7182a3' }}>
        <summary style={{ cursor: 'pointer', color: '#8ea5e6' }}>Method and limitations</summary>
        <ul style={{ margin: '7px 0 0', paddingLeft: 18 }}>
          {computed.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
        </ul>
      </details>
    </section>
  );
}

export default DsmView;
