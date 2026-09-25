/**
 * Cross-layer conformance, frontend half (roadmap P1-1).
 *
 * Reads the generated corpus in `test/fixtures/activity/generated/` — produced
 * by the real producer normaliser, see `producer/test/fixtures.mjs` — and
 * asserts the frontend parser accepts every envelope and preserves the fields
 * the producer declared. A producer change that the frontend silently drops
 * turns this red.
 *
 * Deliberately NOT asserted: resource `name`/`ref`/`provider`. `safeResource`
 * drops those today (roadmap T2-B adds them); asserting them here would encode
 * a capability the frontend does not have.
 *
 * Node built-ins are pulled in through the same computed-specifier trick the
 * sibling tests use: the frontend tsconfig has no `@types/node`, and this file
 * is not worth pulling node types into `src` for.
 */
import { parseActivityEvent } from './contract';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity conformance assertion failed: ${message}`);
}

interface NodeFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
}

const fs = await import('node:' + 'fs') as unknown as NodeFs;
const { cwd } = await import('node:' + 'process') as unknown as { cwd: () => string };

const FIXTURE_DIR = `${cwd()}/test/fixtures/activity/generated`;
const DECLARED_FIELDS = ['sessionName', 'agentName', 'type', 'status', 'tool', 'toolCallId'] as const;

export function runActivityConformanceAssertions(): void {
  const files = fs.existsSync(FIXTURE_DIR)
    ? fs.readdirSync(FIXTURE_DIR).filter(entry => entry.endsWith('.json')).sort()
    : [];
  expect(files.length > 0, `found generated envelopes in ${FIXTURE_DIR} (run \`npm run fixtures\`)`);

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8')) as Record<string, unknown>;
    const parsed = parseActivityEvent(raw);
    expect(parsed !== null, `${file}: parseActivityEvent accepts the envelope`);
    if (!parsed) continue;

    for (const field of DECLARED_FIELDS) {
      if (raw[field] === undefined) continue;
      expect(parsed[field] === raw[field],
        `${file}: ${field} survives parsing (declared ${JSON.stringify(raw[field])}, parsed ${JSON.stringify(parsed[field])})`);
    }

    if (Array.isArray(raw.resources)) {
      const parsedCount = parsed.resources?.length ?? 0;
      expect(parsedCount === raw.resources.length,
        `${file}: keeps all ${raw.resources.length} declared resources (parsed ${parsedCount})`);
    }
  }
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity conformance', runActivityConformanceAssertions);
