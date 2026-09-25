import { SECRET_KEY, SENSITIVE_ASSIGNMENT } from '../../producer/src/redact.mjs';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Redaction coverage assertion failed: ${message}`);
}

// Mirrors the widened regex at src/activity/contract.ts:44 and :129. There is
// no shared export between contract.ts and this test (contract.ts's exports
// are deliberately scoped elsewhere), so this pattern is kept as a literal
// copy -- update it here whenever contract.ts's redaction regex changes.
const FRONTEND_REDACTION_RE = /\b((?:Bearer|Basic|Token)\s*(?:[:=]\s*|\s+)|(?:password|passwd|token|secret|api[_-]?key|authorization|cookie|credential|access[_-]?key|private[_-]?key)\s*[:=]\s*(?!(?:Bearer|Basic|Token)\b))\S+/gi;

// SECRET_KEY (producer/src/redact.mjs) also matches generic content-shape
// markers -- prompt, content, result, argument, command, code, environment,
// env, stack -- that gate whether an entire metadata field is dropped
// wholesale in redactMetadata's key filtering. Those are not credential
// *names*; the frontend's embedded "key: value" text-redaction regex targets
// actual secret-shaped assignments (mirroring producer's SENSITIVE_ASSIGNMENT)
// and does not need to also fire on ordinary words like "content" or "code" --
// that job belongs to contract.ts's separate UNSAFE_SNIPPET_KEY / safeMetadata
// key filtering, which is out of scope for P1-10.
const STRUCTURAL_KEY_TERMS = new Set([
  'prompt', 'content', 'result', 'argument', 'command', 'code', 'environment', 'env', 'stack',
]);

// Extracts the alternation terms from either an unnamed capturing group
// "(a|b|c)" (SECRET_KEY) or a non-capturing group "(?:a|b|c)"
// (SENSITIVE_ASSIGNMENT), so this test tracks both producer patterns without
// hand-copying their term lists.
function alternationTerms(source: string): string[] {
  const match = source.match(/\(\??:?([^()]+)\)/);
  if (!match) throw new Error(`could not parse an alternation group from regex source: ${source}`);
  return match[1].split('|').map(term => term.trim()).filter(Boolean);
}

// "api[-_]?key" -> "api-key" etc. so each term is a literal, embeddable string.
function toLiteral(term: string): string {
  return term.replace(/\[-_\]\?/g, '-').replace(/\\b/g, '');
}

function frontendRedacts(sample: string): boolean {
  FRONTEND_REDACTION_RE.lastIndex = 0;
  return FRONTEND_REDACTION_RE.test(sample);
}

export function runRedactionCoverageAssertions(): void {
  const credentialTerms = new Set([
    ...alternationTerms(SECRET_KEY.source).filter(term => !STRUCTURAL_KEY_TERMS.has(term)),
    ...alternationTerms(SENSITIVE_ASSIGNMENT.source),
  ].map(toLiteral));

  expect(credentialTerms.size >= 10, `expected at least 10 producer credential terms, found ${credentialTerms.size}`);

  for (const term of credentialTerms) {
    expect(frontendRedacts(`${term}: super-secret-value-123`), `frontend redaction regex does not match producer term "${term}" (colon form) -- widen src/activity/contract.ts:44 and :129`);
    expect(frontendRedacts(`${term}=super-secret-value-123`), `frontend redaction regex does not match producer term "${term}" (equals form) -- widen src/activity/contract.ts:44 and :129`);
  }

  // The specific P1-10 gap, named explicitly so a future reader can see
  // exactly what regressed once before, independent of the generic loop above.
  for (const term of ['authorization', 'cookie', 'credential', 'access-key', 'private-key']) {
    expect(frontendRedacts(`${term}: abcDEF123456`), `frontend redaction regex must cover the P1-10 gap term "${term}"`);
  }

  const redacted = 'authorization: abcDEF123456xyz'.replace(FRONTEND_REDACTION_RE, '$1=[redacted]');
  expect(!redacted.includes('abcDEF123456xyz'), 'redaction must strip the secret value, not merely match it');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity redaction coverage', runRedactionCoverageAssertions);
