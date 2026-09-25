import { memo } from 'react';
import type { NamespaceMetrics } from '../namespaceMetrics';
import type { CodeNode } from '../types';

export const Inspector = memo(function Inspector({ node, namespaceMetrics, onFocus }: { node: CodeNode | null; namespaceMetrics?: Map<string, NamespaceMetrics>; onFocus: () => void }) {
  if (!node) {
    return <section className="inspector empty-inspector"><span className="eyebrow">Selection</span><p>Click a node to inspect its source location, metadata, and neighborhood.</p></section>;
  }
  const namespaceMetric = node.namespace ? namespaceMetrics?.get(node.namespace) : undefined;
  return (
    <section className="inspector">
      <div className="inspector-heading"><span className={`kind-dot kind-${node.kind}`} /><div><span className="eyebrow">{node.kind}{node.external ? ' / external' : ''}</span><h2>{node.label}</h2></div></div>
      {node.fqn && <code className="fqn">{node.fqn}</code>}
      {node.doc && <p className="doc">{node.doc}</p>}
      {node.file && <div className="source-location"><span>Source</span><code>{node.file}{node.row ? `:${node.row}:${node.col ?? 1}` : ''}</code></div>}
      <div className="badges">
        {node.private && <span>private</span>}
        {node.macro && <span>macro</span>}
        {node.deprecated && <span>deprecated</span>}
        {node.usageCount !== undefined && <span>{node.usageCount} uses</span>}
        {node.arities && <span>{node.arities.length} arit{node.arities.length === 1 ? 'y' : 'ies'}</span>}
      </div>
      {namespaceMetric && <div className="namespace-metrics"><span className="eyebrow">Namespace coupling</span><div className="metric-grid"><span><strong>{namespaceMetric.degree}</strong>links</span><span><strong>{namespaceMetric.fanOut}</strong>out</span><span><strong>{namespaceMetric.fanIn}</strong>in</span><span><strong>{Math.round(namespaceMetric.betweenness * 100)}%</strong>bridge</span></div>{namespaceMetric.cycleSize > 1 && <small>part of a {namespaceMetric.cycleSize}-namespace cycle</small>}</div>}
      {node.arglists && node.arglists.length > 0 && <div className="arglists"><span className="eyebrow">Arglists</span>{node.arglists.map(arglist => <code key={arglist}>{arglist}</code>)}</div>}
      <button className="focus-button" onClick={onFocus}>Focus neighborhood</button>
    </section>
  );
});
