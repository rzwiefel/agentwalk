export type NodeKind = 'namespace' | 'var' | 'keyword';
export type NodeVisibilityMode = 'always' | 'updated';
export type ConnectionMode = 'off' | 'connected' | 'overdependency';
export type AnalysisView = 'dossier' | 'blast-radius' | 'temporal' | 'communities' | 'dsm';
export type RepositoryAnalysisMode = 'clojure' | 'auto' | 'python' | 'csharp' | 'typescript-javascript';
export type ParserLanguage = Exclude<RepositoryAnalysisMode, 'clojure' | 'auto'>;
export type NodeVisibilityModes = Record<Exclude<NodeKind, 'namespace'>, NodeVisibilityMode>;
export type EdgeKind = 'requires' | 'calls' | 'mentions';
export interface CodeNode {
  id: string;
  kind: NodeKind;
  label: string;
  namespace?: string;
  keywordQualifier?: string;
  fqn?: string;
  file?: string;
  projectId?: string;
  projectName?: string;
  assemblyName?: string;
  projectPath?: string;
  row?: number;
  col?: number;
  endRow?: number;
  endCol?: number;
  doc?: string;
  external?: boolean;
  private?: boolean;
  macro?: boolean;
  deprecated?: boolean;
  synthetic?: boolean;
  resolutionStatus?: string;
  arities?: number[];
  arglists?: string[];
  lexicalNamespaces?: string[];
  usageCount?: number;
}

export interface EdgeEvidence {
  source: string;
  file?: string;
  start?: {
    line: number;
    column: number;
  };
  end?: {
    line: number;
    column: number;
  };
  occurrenceIndex: number;
}

export interface CodeEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  file?: string;
  row?: number;
  col?: number;
  endRow?: number;
  endCol?: number;
  occurrenceCount?: number;
  evidence?: EdgeEvidence[];
}

export interface HistoryCommit {
  id: string;
  hash: string;
  shortHash: string;
  message: string;
  author?: string;
  timestamp: string;
  changedNodeIds: string[];
  addedNodeIds: string[];
  changedEdgeIds?: string[];
  changedFiles?: string[];
  addedFiles?: string[];
}

export interface GraphHistory {
  commits: HistoryCommit[];
}

export interface RepositoryInfo {
  name: string;
  root: string;
  head: string;
  commitCount: number;
  commits: HistoryCommit[];
}

export interface ParserDiagnostic {
  id?: string;
  code?: string;
  severity?: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  recoverable?: boolean;
  fatal?: boolean;
  [key: string]: unknown;
}

export interface ParserCapabilitiesAdapter {
  name: string;
  displayName?: string;
  description?: string;
  runtime?: string;
  detected?: boolean;
  available?: boolean;
  runtimeAvailable?: boolean;
  adapterAvailable?: boolean;
  status?: string;
  message?: string;
  reason?: string;
  missingRuntime?: boolean;
  [key: string]: unknown;
}

export interface ParserRepositoryDetection {
  selected?: string | null;
  ambiguous?: boolean;
  candidates?: string[];
  reason?: string;
  signals?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface ParserCapabilities {
  command?: string;
  repository?: ParserRepositoryDetection;
  adapters?: ParserCapabilitiesAdapter[];
  [key: string]: unknown;
}

export interface GraphAnalysis {
  mode: 'full' | 'incremental' | 'incremental-map' | 'cached';
  files: number;
}

export type RevisionMode = 'full' | 'cached' | 'incremental-map';
export type GlobalNamespaceLayoutMode = 'bottom' | 'orbit';

export interface RevisionMetadata {
  commit: string;
  parentCommit?: string;
  mode: RevisionMode;
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  renamedFiles: string[];
  limitations: string[];
}

export interface CodeGraph {
  formatVersion: number;
  analysis?: GraphAnalysis;
  generatedAt: string;
  repo: {
    name: string;
    root: string;
  };
  nodes: CodeNode[];
  edges: CodeEdge[];
  stats: Record<string, number>;
  history?: GraphHistory;
  revision?: RevisionMetadata;
}

export type GraphPositions = Map<string, [number, number, number]>;

export interface LayoutGroup {
  id: string;
  parentId: string | null;
  path: string;
  label: string;
  depth: number;
  center: [number, number, number];
  size: [number, number, number];
  actualNamespace?: string;
  namespaceNodeId?: string;
  virtual: boolean;
  nodeCount: number;
  global?: boolean;
  activitySlot?: [number, number];
  activity?: {
    kind: 'bash' | 'tool' | 'project' | 'file' | 'directory' | 'web' | 'domain';
    tool?: string;
    projectId?: string;
    projectRoot?: string;
    path?: string;
    lastActivityAt?: number;
    expiresAt?: number;
    /** Mirrors ActivityGroupSpec.lastOutcome (T2-D remainder); undefined until a tests/git/build family group or domain sphere reports one. */
    lastOutcome?: 'completed' | 'failed';
  };
}

export interface LayoutBounds {
  center: [number, number, number];
  size: [number, number, number];
  diagonal: number;
}

export interface ActivityAgentLayout {
  id: string;
  agentId: string;
  sessionId: string;
  sessionName?: string;
  label: string;
  status: string;
  activity: string;
  color: string;
  lastEventId: string;
  updatedAt: number;
  center: [number, number, number];
  size: [number, number, number];
  workspaceId?: string;
  source?: string;
  parentId?: string;
  /** Mirrors ActivityAgentNode.waitingSince (T1-B); set while a permission request owned by this agent is unresolved. */
  waitingSince?: number;
  waitingToolCallId?: string;
  /** Mirrors ActivityAgentNode.lastDeniedAt (T1-B); last time a permission this agent owned resolved to a `denied-*` kind. */
  lastDeniedAt?: number;
}

export interface LayoutResult {
  positions: Map<string, [number, number, number]>;
  groups: LayoutGroup[];
  hierarchyBounds: LayoutBounds;
  activityAgents?: ActivityAgentLayout[];
  activityInactiveAgents?: ActivityAgentLayout[];
  orbit?: {
    center: [number, number, number];
    radius: number;
    globalNodeIds: string[];
  };
}
