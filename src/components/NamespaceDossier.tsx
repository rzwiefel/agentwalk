import { memo } from 'react';
import type { CodeNode } from '../types';
import {
  buildNamespaceDossier,
  type GraphLike,
  type NamespaceDossierData,
  type NamespaceDossierOptions,
  type NamespaceRelationship,
  type NamespaceSelection,
  type SourceEvidence,
} from '../connectionExplain';

export interface NamespaceDossierSummary {
  varCount?: number;
  publicVars?: number;
  keywordCount?: number;
}

export interface NamespaceDossierFacts {
  fanIn?: number;
  fanOut?: number;
  degree?: number;
  betweenness?: number;
  connectedness?: number;
  cycleSize?: number;
  centrality?: number;
  cohesion?: number;
}

export interface DossierCandidate {
  namespace?: string;
  label?: string;
  reason?: string;
  score?: number;
  evidence?: readonly SourceEvidence[];
}

export interface NamespaceDossierProps {
  graph?: GraphLike | null;
  selection?: NamespaceSelection;
  dossier?: NamespaceDossierData | null;
  dossierOptions?: NamespaceDossierOptions;
  namespace?: string | null;
  node?: CodeNode | null;
  summary?: NamespaceDossierSummary | null;
  vars?: readonly CodeNode[] | null;
  metrics?: NamespaceDossierFacts;
  relationships?: readonly NamespaceRelationship[] | null;
  directDependencies?: readonly NamespaceRelationship[] | null;
  incomingRelationships?: readonly NamespaceRelationship[] | null;
  outgoingRelationships?: readonly NamespaceRelationship[] | null;
  coChangeCandidates?: readonly DossierCandidate[] | null;
  hiddenCouplingCandidates?: readonly DossierCandidate[] | null;
  evidence?: readonly SourceEvidence[] | null;
  sourceEvidence?: readonly SourceEvidence[] | null;
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
  onExplainConnection?: (targetNamespace: string) => void;
  onSelectNamespace?: (namespace: string) => void;
}

function evidenceKey(item: SourceEvidence): string {
  return [item.file ?? '', item.row ?? '', item.col ?? '', item.href ?? item.url ?? '', item.location ?? ''].join('\u0000');
}

function evidenceLabel(item: SourceEvidence): string {
  if (item.location) return item.location;
  if (item.file) return `${item.file}${item.row === undefined ? '' : `:${item.row}${item.col === undefined ? '' : `:${item.col}`}`}`;
  return item.label ?? item.href ?? item.url ?? 'Source evidence';
}

function evidenceWithId(item: SourceEvidence): string {
  return item.edgeId ? `${item.edgeId} · ${evidenceLabel(item)}` : evidenceLabel(item);
}

function evidenceHref(item: SourceEvidence): string | undefined {
  const href = item.href ?? item.url;
  if (!href) return undefined;
  return /^(https?:\/\/|\/|\.\/|\.\.\/|#)/.test(href) ? href : undefined;
}

function EvidenceList({ items }: { items: readonly SourceEvidence[] }) {
  if (items.length === 0) return <span className="dossier-muted">Not supplied</span>;
  return (
    <ul className="dossier-evidence-list">
      {items.map(item => {
        const href = evidenceHref(item);
        return <li key={evidenceKey(item)}>{href ? <a href={href} target="_blank" rel="noreferrer">{evidenceWithId(item)}</a> : <code>{evidenceWithId(item)}</code>}</li>;
      })}
    </ul>
  );
}

function Metric({ label, value, format = String }: { label: string; value: number | undefined; format?: (value: number) => string }) {
  if (value === undefined || !Number.isFinite(value)) return null;
  return <div className="dossier-metric"><strong>{format(value)}</strong><span>{label}</span></div>;
}

function CandidateList({ candidates }: { candidates: readonly DossierCandidate[] }) {
  if (candidates.length === 0) return <p className="dossier-muted">None supplied.</p>;
  return (
    <ul className="dossier-candidate-list">
      {candidates.map((candidate, index) => (
        <li key={`${candidate.namespace ?? candidate.label ?? 'candidate'}\u0000${index}`}>
          <strong>{candidate.label ?? candidate.namespace ?? 'Candidate'}</strong>
          {candidate.reason && <span>{candidate.reason}</span>}
          {candidate.score !== undefined && Number.isFinite(candidate.score) && <code>score {candidate.score}</code>}
          {candidate.evidence && candidate.evidence.length > 0 && <EvidenceList items={candidate.evidence} />}
        </li>
      ))}
    </ul>
  );
}

export const NamespaceDossier = memo(function NamespaceDossier({
  graph,
  selection,
  dossier,
  dossierOptions,
  namespace,
  node,
  summary,
  vars,
  metrics,
  relationships,
  directDependencies,
  incomingRelationships,
  outgoingRelationships,
  coChangeCandidates,
  hiddenCouplingCandidates,
  evidence,
  sourceEvidence,
  loading = false,
  emptyMessage = 'Select a namespace or a namespace-owned var to inspect its dossier.',
  className,
  onExplainConnection,
  onSelectNamespace,
}: NamespaceDossierProps) {
  const selectedInput = selection ?? namespace ?? node;
  const computedDossier = dossier ?? (graph && selectedInput ? buildNamespaceDossier(graph, selectedInput, dossierOptions) : undefined);
  const identity = computedDossier?.namespace ?? namespace ?? (node?.kind === 'namespace' ? node.namespace ?? node.label : node?.namespace);
  const computedRelationships = computedDossier
    ? [...computedDossier.outgoing, ...computedDossier.incoming, ...computedDossier.selfLinks]
    : [];
  const allRelationships = relationships ?? directDependencies ?? (computedRelationships.length > 0 ? computedRelationships : [
    ...(outgoingRelationships ?? []),
    ...(incomingRelationships ?? []),
  ]);
  const uniqueRelationships = [...new Map(allRelationships.map(relationship => [
    `${relationship.direction}\u0000${relationship.otherNamespace}\u0000${relationship.kind}`,
    relationship,
  ])).values()];
  const varNodes = vars?.filter(item => item.kind === 'var');
  const varCount = summary?.varCount ?? computedDossier?.counts.vars ?? (varNodes ? varNodes.length : undefined);
  const publicVarCount = summary?.publicVars ?? (varNodes ? varNodes.filter(item => item.private !== true).length : undefined);
  const suppliedEvidence = [...(evidence ?? []), ...(sourceEvidence ?? [])];
  const relationshipEvidence = uniqueRelationships.flatMap(relationship => relationship.evidence);
  const allEvidence = [...new Map([...suppliedEvidence, ...relationshipEvidence].map(item => [evidenceKey(item), item])).values()];
  const hasPartialEvidence = uniqueRelationships.some(relationship => !relationship.evidenceAvailable)
    || (uniqueRelationships.length > 0 && allEvidence.length === 0);
  const metricCentrality = metrics?.centrality ?? metrics?.betweenness;
  const metricCohesion = metrics?.cohesion;
  const metricCycle = metrics?.cycleSize;
  const dossierCounts = computedDossier?.counts;
  const mentionRelationships = computedDossier
    ? [...computedDossier.mentions.outgoing, ...computedDossier.mentions.incoming, ...computedDossier.mentions.selfLinks]
    : [];
  const metricValues = [
    <Metric key="fan-in" label="fan-in" value={metrics?.fanIn} />,
    <Metric key="fan-out" label="fan-out" value={metrics?.fanOut} />,
    <Metric key="degree" label="degree" value={metrics?.degree} />,
    <Metric key="centrality" label="centrality" value={metricCentrality} format={value => `${Math.round(value * 100)}%`} />,
    <Metric key="cycle" label="cycle size" value={metricCycle} />,
    <Metric key="cohesion" label="cohesion" value={metricCohesion} format={value => `${Math.round(value * 100)}%`} />,
    <Metric key="connectedness" label="connectedness" value={metrics?.connectedness} format={value => `${Math.round(value * 100)}%`} />,
  ].filter(Boolean);

  if (loading) {
    return <section className={className ? `namespace-dossier ${className}` : 'namespace-dossier'} aria-busy="true"><span className="eyebrow">Namespace dossier</span><p>Loading dossier evidence…</p></section>;
  }
  if (!identity) {
    return <section className={className ? `namespace-dossier empty-dossier ${className}` : 'namespace-dossier empty-dossier'}><span className="eyebrow">Namespace dossier</span><p>{emptyMessage}</p></section>;
  }

  return (
    <section className={className ? `namespace-dossier ${className}` : 'namespace-dossier'}>
      <header className="dossier-header">
        <span className="eyebrow">Namespace dossier</span>
        <h2>{identity}</h2>
        {node?.doc && <p>{node.doc}</p>}
        {node?.file && <code>{node.file}{node.row === undefined ? '' : `:${node.row}${node.col === undefined ? '' : `:${node.col}`}`}</code>}
      </header>

      {(summary || vars || varCount !== undefined || publicVarCount !== undefined) && (
        <section className="dossier-section" aria-labelledby="dossier-summary-heading">
          <h3 id="dossier-summary-heading">Public / var summary</h3>
          <div className="dossier-summary">
            <Metric label="vars" value={varCount} />
            <Metric label="public" value={publicVarCount} />
            <Metric label="keywords" value={summary?.keywordCount} />
          </div>
        </section>
      )}

      {dossierCounts && (
        <section className="dossier-section" aria-labelledby="dossier-counts-heading">
          <h3 id="dossier-counts-heading">Evidence counts</h3>
          <div className="dossier-summary">
            <Metric label="incoming" value={dossierCounts.incoming} />
            <Metric label="outgoing" value={dossierCounts.outgoing} />
            <Metric label="self-links" value={dossierCounts.selfLinks} />
            <Metric label="edges" value={dossierCounts.structuralEdges} />
            <Metric label="occurrences" value={dossierCounts.structuralOccurrences} />
            <Metric label="external in" value={dossierCounts.externalIncoming} />
            <Metric label="external out" value={dossierCounts.externalOutgoing} />
          </div>
        </section>
      )}

      {metricValues.length > 0 && (
        <section className="dossier-section" aria-labelledby="dossier-metrics-heading">
          <h3 id="dossier-metrics-heading">Metrics</h3>
          <div className="dossier-metrics">{metricValues}</div>
        </section>
      )}

      <section className="dossier-section" aria-labelledby="dossier-relationships-heading">
        <h3 id="dossier-relationships-heading">Structural relationships</h3>
        {uniqueRelationships.length === 0
          ? <p className="dossier-muted">No direct relationships supplied.</p>
          : <div className="dossier-table-wrap"><table><thead><tr><th scope="col">Direction</th><th scope="col">Namespace</th><th scope="col">Kind</th><th scope="col">Count</th><th scope="col">Edge IDs</th><th scope="col">Evidence</th><th scope="col">Explain</th></tr></thead><tbody>{uniqueRelationships.map(relationship => <tr key={`${relationship.direction}\u0000${relationship.otherNamespace}\u0000${relationship.kind}`}><td>{relationship.direction === 'outgoing' ? 'outgoing' : relationship.direction === 'incoming' ? 'incoming' : 'self'}</td><td><code>{relationship.otherNamespace}</code>{relationship.external && <span> (external)</span>}{relationship.otherNamespace !== identity && onSelectNamespace && <button type="button" onClick={() => onSelectNamespace(relationship.otherNamespace)}>select</button>}</td><td>{relationship.kind}</td><td>{relationship.occurrenceCount ?? relationship.multiplicity}</td><td><EvidenceList items={relationship.edgeIds.map(edgeId => ({ edgeId, label: edgeId }))} /></td><td><EvidenceList items={relationship.evidence} /></td><td>{relationship.otherNamespace !== identity && onExplainConnection && <button type="button" onClick={() => onExplainConnection(relationship.otherNamespace)}>why?</button>}</td></tr>)}</tbody></table></div>}
      </section>

      {computedDossier && (
       <section className="dossier-section" aria-labelledby="dossier-mentions-heading">
         <h3 id="dossier-mentions-heading">Mentions (non-structural)</h3>
         {mentionRelationships.length === 0
           ? <p className="dossier-muted">No mention relationships supplied.</p>
           : <div className="dossier-table-wrap"><table><thead><tr><th scope="col">Direction</th><th scope="col">Namespace</th><th scope="col">Count</th><th scope="col">Evidence</th></tr></thead><tbody>{mentionRelationships.map(relationship => <tr key={`${relationship.direction}\u0000${relationship.otherNamespace}\u0000${relationship.kind}`}><td>{relationship.direction}</td><td><code>{relationship.otherNamespace}</code></td><td>{relationship.occurrenceCount ?? relationship.multiplicity}</td><td><EvidenceList items={relationship.evidence} /></td></tr>)}</tbody></table></div>}
       </section>
      )}

      {(coChangeCandidates || hiddenCouplingCandidates) && (
        <section className="dossier-section" aria-labelledby="dossier-derived-heading">
          <h3 id="dossier-derived-heading">Derived candidates</h3>
          {coChangeCandidates && <div><h4>Co-change</h4><CandidateList candidates={coChangeCandidates} /></div>}
          {hiddenCouplingCandidates && <div><h4>Hidden coupling</h4><CandidateList candidates={hiddenCouplingCandidates} /></div>}
        </section>
      )}

      <section className="dossier-section" aria-labelledby="dossier-evidence-heading">
        <h3 id="dossier-evidence-heading">Source evidence</h3>
        <EvidenceList items={allEvidence} />
        {hasPartialEvidence && <p className="dossier-muted">Some relationships have no source evidence in this graph.</p>}
      </section>
    </section>
  );
});

export default NamespaceDossier;
