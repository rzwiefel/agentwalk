import type {
  ParserCapabilities,
  ParserDiagnostic,
  ParserLanguage,
  RevisionMetadata,
} from './types';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ParserAnalysisSuccess {
  ok: true;
  language?: string;
  graph: unknown;
  ir?: unknown;
  diagnostics?: ParserDiagnostic[];
  status?: string;
  revision?: RevisionMetadata;
  [key: string]: unknown;
}

interface ParserErrorPayload {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

export class ParserApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status?: number;

  constructor(code: string, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'ParserApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function errorFromPayload(value: unknown, fallbackCode: string, fallbackMessage: string, status?: number): ParserApiError {
  const payload = record(value);
  const error = record(payload.error) as ParserErrorPayload;
  const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : fallbackCode;
  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : fallbackMessage;
  return new ParserApiError(code, message, error.details ?? payload.details, status);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParserApiError(
      'MALFORMED_RESPONSE',
      `Parser service returned invalid JSON (${response.status}).`,
      { status: response.status, body: text.slice(0, 500) },
      response.status,
    );
  }
}

async function requestJson<T>(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = init.signal;
  const abort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'AbortError') {
        if (callerSignal?.aborted) {
          throw new ParserApiError('ABORTED', 'Parser request was superseded by a newer request.');
        }
        throw new ParserApiError('TIMEOUT', `Parser request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw new ParserApiError('NETWORK_ERROR', 'Unable to reach the parser service.', { cause: reason instanceof Error ? reason.message : reason });
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      throw errorFromPayload(payload, 'PARSER_REQUEST_FAILED', `Parser request failed (${response.status}).`, response.status);
    }
    return payload as T;
  } finally {
    globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}

function pathQuery(path: string): string {
  // An empty path omits the query parameter entirely rather than erroring:
  // /api/parser/capabilities falls back to the server's configured
  // --repo-root/parser root when `path` is absent (src/codewalk/parser.clj's
  // `capabilities` does `(target-root (or path default-root parser-root))`).
  const trimmed = path.trim();
  return trimmed ? `?path=${encodeURIComponent(trimmed)}` : '';
}

function diagnostics(value: unknown): ParserDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map(item => {
      const input = record(item);
      return {
        ...input,
        message: typeof input.message === 'string' && input.message.length > 0 ? input.message : 'Parser diagnostic',
      };
    });
  return result;
}

export async function loadParserCapabilities(path: string, signal?: AbortSignal): Promise<ParserCapabilities> {
  const payload = await requestJson<unknown>(`/api/parser/capabilities${pathQuery(path)}`, { method: 'GET', signal });
  if (record(payload).ok === false) {
    throw errorFromPayload(payload, 'PARSER_CAPABILITIES_FAILED', 'Unable to read parser capabilities.');
  }
  return payload as ParserCapabilities;
}

export interface ParserAnalyzeOptions {
  commit?: string;
  previousCommit?: string;
  signal?: AbortSignal;
}

export function serializeParserRequest(path: string, language: 'auto' | ParserLanguage, options: ParserAnalyzeOptions = {}) {
  const body: { path: string; language: string; includeIr: false; commit?: string; previousCommit?: string } = {
    path: path.trim(),
    language,
    includeIr: false,
  };
  if (options.commit) body.commit = options.commit;
  if (options.previousCommit) body.previousCommit = options.previousCommit;
  return body;
}

export async function analyzeParser(path: string, language: 'auto' | ParserLanguage, options: ParserAnalyzeOptions = {}): Promise<ParserAnalysisSuccess> {
  const payload = await requestJson<unknown>('/api/parser/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serializeParserRequest(path, language, options)),
    signal: options.signal,
  });
  const input = record(payload);
  if (input.ok === false) {
    throw errorFromPayload(input, 'PARSER_ANALYSIS_FAILED', 'Parser analysis failed.');
  }
  if (input.ok !== true || input.graph === undefined) {
    throw new ParserApiError('MALFORMED_RESPONSE', 'Parser analysis did not return a graph.', { response: payload });
  }
  return {
    ...input,
    ok: true,
    graph: input.graph,
    diagnostics: diagnostics(input.diagnostics) ?? diagnostics(record(input.graph).diagnostics),
    revision: (record(input.revision).commit && record(input.revision).mode
      ? input.revision as RevisionMetadata
      : undefined),
  } as ParserAnalysisSuccess;
}
