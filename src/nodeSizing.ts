import type { CodeNode } from './types';

function sourceLines(node: CodeNode): number {
  if (node.row !== undefined && node.endRow !== undefined) return Math.max(1, node.endRow - node.row + 1);
  if (node.row !== undefined) return 1;
  return 0;
}

function nodeMetric(node: CodeNode, namespaceSubtreeCounts: Map<string, number>): number {
  if (node.kind === 'namespace') return namespaceSubtreeCounts.get(node.namespace ?? '') ?? 1;
  if (node.kind === 'keyword') return Math.max(1, node.usageCount ?? 1);
  const loc = sourceLines(node);
  const documentedLines = node.doc ? Math.ceil(node.doc.length / 80) : 0;
  const signatures = node.arglists?.length ?? node.arities?.length ?? 0;
  return Math.max(1, loc, documentedLines, signatures);
}

export function nodeSizeFactor(node: CodeNode, namespaceSubtreeCounts: Map<string, number>): number {
  const metric = nodeMetric(node, namespaceSubtreeCounts);
  return Math.min(1.9, Math.max(0.72, 0.72 + Math.log2(metric + 1) * 0.11));
}
