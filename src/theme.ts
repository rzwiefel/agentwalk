import type { NodeKind } from './types';

export function nodeColor(kind: NodeKind, external = false, testNamespace = false): string {
  if (external) return '#657494';
  if (testNamespace && kind === 'namespace') return '#72acc6';
  if (kind === 'namespace') return '#7898ff';
  if (kind === 'keyword') return '#df8eff';
  return '#49d8b0';
}


export function nodePulseColor(kind: NodeKind, testNamespace = false): string {
  if (testNamespace && kind === 'namespace') return '#68c4d6';
  if (kind === 'namespace') return '#54a8ff';
  if (kind === 'keyword') return '#e69bff';
  return '#38f2b0';
}
