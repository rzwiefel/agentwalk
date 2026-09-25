export type SourceLanguage = 'typescript' | 'javascript';
export type NodeKind = 'namespace' | 'var';
export type VarKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'method'
  | 'variable'
  | 'property'
  | 'enum'
  | 'parameter'
  | 'jsx-intrinsic'
  | 'external';
export type RelationshipKind =
  | 'requires'
  | 'calls'
  | 'mentions'
  | 'extends'
  | 'implements'
  | 'exports'
  | 'reexports'
  | 'overrides'
  | 'contains';
export type Resolution = 'resolved' | 'external' | 'ambiguous' | 'unresolved';

export interface Span {
  file: string;
  start: number;
  end: number;
  row: number;
  col: number;
  endRow: number;
  endCol: number;
}

export interface Occurrence {
  role: string;
  span: Span;
  text: string;
  detail?: Record<string, string>;
}

export interface ParserNode {
  id: string;
  kind: NodeKind;
  label: string;
  varKind?: VarKind;
  namespace?: string;
  fqn?: string;
  file?: string;
  span?: Span;
  external?: boolean;
  packageName?: string;
  language?: SourceLanguage;
  occurrences: Occurrence[];
}

export interface ParserEdge {
  id: string;
  kind: RelationshipKind;
  source: string;
  target: string;
  resolution: Resolution;
  confidence: number;
  provenance: string;
  span: Span;
  text: string;
  detail?: Record<string, string>;
}

export interface ParserDiagnostic {
  code: string;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  message: string;
  span?: Span;
  file?: string;
}

export interface Ownership {
  file: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface AnalysisInfo {
  mode: 'full' | 'incremental';
  projectFile?: string;
  files: string[];
  changedFiles: string[];
  invalidatedFiles: string[];
  ownership: Ownership[];
}

export interface ParserGraph {
  formatVersion: 1;
  root: string;
  nodes: ParserNode[];
  edges: ParserEdge[];
  diagnostics: ParserDiagnostic[];
  analysis: AnalysisInfo;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return nested;
  });
}
