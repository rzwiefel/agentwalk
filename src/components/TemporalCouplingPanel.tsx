import type { TemporalCouplingAnalysis } from '../temporalCoupling';

interface TemporalCouplingPanelProps {
  analysis: TemporalCouplingAnalysis;
  selectedNamespace?: string | null;
  onSelectNamespace?: (namespace: string) => void;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function TemporalCouplingPanel({
  analysis,
  selectedNamespace,
  onSelectNamespace,
}: TemporalCouplingPanelProps) {
  const selectedCouplings = selectedNamespace
    ? analysis.couplings.filter(coupling => coupling.namespaceA === selectedNamespace || coupling.namespaceB === selectedNamespace)
    : [];
  const visible = (selectedNamespace ? selectedCouplings : analysis.couplings).slice(0, 24);
  return (
    <section className="analysis-panel temporal-coupling-panel" aria-label="Temporal change coupling">
      <header className="analysis-panel-heading">
        <div>
          <span className="eyebrow">History / change coupling</span>
          <h2>Namespaces that change together</h2>
        </div>
        <span className={`coverage-badge coverage-${analysis.coverageState}`}>{analysis.coverageState}</span>
      </header>
      <p className="analysis-selection">
        Selected namespace: <strong>{selectedNamespace ?? 'none'}</strong>
        {selectedNamespace && selectedCouplings.length > 0 && ` · ${selectedCouplings.length} related pair${selectedCouplings.length === 1 ? '' : 's'}`}
      </p>
      <p className="analysis-muted">
        Co-change is a statistical signal, not proof of a dependency. Results are based on
        {` ${analysis.coverage.observableCommitCount.toLocaleString()} `}
        observable commits.
      </p>
      {analysis.coverageReason && <p className="analysis-warning">{analysis.coverageReason}</p>}
      {visible.length === 0 ? (
        <p className="analysis-muted">{selectedNamespace ? 'No temporal coupling is recorded for this namespace.' : 'No namespace pairs meet the current evidence threshold.'}</p>
      ) : (
        <div className="analysis-table-wrap">
          <table className="analysis-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Co-change</th>
                <th>Lift</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(coupling => {
                const highlighted = selectedNamespace === coupling.namespaceA || selectedNamespace === coupling.namespaceB;
                return (
                  <tr key={coupling.pairKey} className={highlighted ? 'is-selected' : undefined}>
                    <td>
                      <button type="button" onClick={() => onSelectNamespace?.(coupling.namespaceA)}>{coupling.namespaceA}</button>
                      <span className="analysis-arrow">↔</span>
                      <button type="button" onClick={() => onSelectNamespace?.(coupling.namespaceB)}>{coupling.namespaceB}</button>
                      {coupling.hiddenCouplingCandidate && <span className="analysis-flag">hidden</span>}
                    </td>
                    <td>{coupling.coChangeCount} <small>{percent(coupling.confidence)} confidence</small></td>
                    <td>{coupling.lift === null ? '—' : coupling.lift.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {analysis.hiddenCouplingCandidates.length > 0 && (
        <p className="analysis-warning">
          {analysis.hiddenCouplingCandidates.length} pair{analysis.hiddenCouplingCandidates.length === 1 ? '' : 's'} repeatedly co-change without a known static edge.
        </p>
      )}
      <details className="analysis-method">
        <summary>Coverage and limitations</summary>
        <ul>
          {analysis.coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}
          <li>High lift can reflect release-wide edits or shared configuration rather than direct coupling.</li>
        </ul>
      </details>
    </section>
  );
}

export default TemporalCouplingPanel;
