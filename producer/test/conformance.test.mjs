/**
 * Cross-layer conformance (roadmap P1-1).
 *
 * By default this writes nothing: it regenerates the corpus from the live
 * normaliser and asserts every envelope byte-equals its committed file under
 * `test/fixtures/activity/generated/`. Run `npm run fixtures`
 * (`UPDATE_FIXTURES=1`) to rewrite the files after an intentional change.
 *
 * The Clojure collector suite and the frontend suite read the same files, so a
 * producer change that drifts from either one turns this red.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FORBIDDEN_INPUT_MARKERS, generateEnvelopes } from "./fixtures.mjs";
import { MAX_EVENT_RESOURCES, normalizeHook } from "../src/contract.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "activity", "generated");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

/** The collector's `sensitive-fields`, minus `content` (handled separately). */
const SENSITIVE_KEYS = new Set([
  "prompt", "message", "command", "arguments", "result", "output", "code", "headers", "env",
]);
/** The only shape `validate-content` accepts (src/codewalk/activity.clj). */
const CONTENT_REFERENCE_KEYS = new Set([
  "availability", "localRef", "localReference", "mimeType", "size", "sha256", "redacted",
]);

/** Sort keys recursively so a fixture's bytes do not depend on insertion order. */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function serialize(envelope) {
  return `${JSON.stringify(stableValue(envelope), null, 2)}\n`;
}

function fixturePath(name) {
  return path.join(FIXTURE_DIR, `${name}.json`);
}

function committedFixtureNames() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR)
    .filter(entry => entry.endsWith(".json"))
    .map(entry => entry.slice(0, -".json".length))
    .sort();
}

/** Visit every key in the envelope tree, reporting a dotted path for failures. */
function eachKey(value, visit, trail = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => eachKey(item, visit, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const location = trail ? `${trail}.${key}` : key;
    visit(key, child, location);
    eachKey(child, visit, location);
  }
}

test("generated envelopes match the committed fixtures", () => {
  const generated = generateEnvelopes();
  assert.ok(generated.length > 0, "the generator produced no envelopes");
  const names = generated.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, "fixture names must be unique");

  if (UPDATE) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const expected = new Set(names);
    for (const stale of committedFixtureNames()) {
      if (!expected.has(stale)) fs.rmSync(fixturePath(stale));
    }
    for (const { name, envelope } of generated) fs.writeFileSync(fixturePath(name), serialize(envelope));
  }

  assert.deepEqual(committedFixtureNames(), [...names].sort(),
    "committed fixtures are stale; run `npm run fixtures`");
  for (const { name, envelope } of generated) {
    const file = fixturePath(name);
    assert.ok(fs.existsSync(file), `missing fixture ${name}.json; run \`npm run fixtures\``);
    assert.equal(fs.readFileSync(file, "utf8"), serialize(envelope),
      `fixture ${name}.json is out of date; run \`npm run fixtures\``);
  }
});

test("generated envelopes carry no content-bearing field", () => {
  for (const { name, envelope } of generateEnvelopes()) {
    eachKey(envelope, (key, child, location) => {
      assert.equal(SENSITIVE_KEYS.has(key), false,
        `${name}: envelope carries the content-bearing key ${location}`);
      if (key !== "content") return;
      assert.ok(child && typeof child === "object" && !Array.isArray(child),
        `${name}: ${location} must be a local-reference object, not ${typeof child}`);
      for (const contentKey of Object.keys(child)) {
        assert.ok(CONTENT_REFERENCE_KEYS.has(contentKey),
          `${name}: ${location}.${contentKey} is outside the content reference shape`);
      }
    });
  }
});

test("generated envelopes carry no raw input text", () => {
  for (const { name, envelope } of generateEnvelopes()) {
    const serialized = JSON.stringify(envelope);
    for (const marker of FORBIDDEN_INPUT_MARKERS) {
      assert.equal(serialized.includes(marker), false, `${name}: envelope leaked ${marker}`);
    }
  }
});

test("concatenated observed and inferred resources are re-capped", () => {
  const capped = generateEnvelopes().find(entry => entry.name === "hook-resource-cap");
  assert.ok(capped, "the resource-cap fixture is missing from the corpus");
  // 40 patch headers + 40 argument paths + 40 shell targets: each list is
  // capped at 32 upstream, so without a re-cap the envelope carries 64 and the
  // collector rejects the whole event.
  assert.ok(capped.envelope.resources.length > 0, "expected resources on the cap fixture");
  assert.ok(capped.envelope.resources.length <= MAX_EVENT_RESOURCES,
    `expected at most ${MAX_EVENT_RESOURCES} resources, got ${capped.envelope.resources.length}`);
});

// T1-P: named assertions (not just byte-equality against the committed file)
// that the specific derivations the frontend brief builds against are the
// ones actually landing on the envelope.
test("permission, failure, and outcome envelopes carry the shapes the frontend expects", () => {
  const byName = new Map(generateEnvelopes().map(entry => [entry.name, entry.envelope]));

  const requested = byName.get("sdk-permission-requested-shell");
  assert.equal(requested.type, "permission");
  assert.equal(requested.status, "requested");
  assert.equal(requested.toolCallId, "req-shell-1", "toolCallId should fall back to requestId");
  assert.equal(requested.metadata.permissionKind, "shell");

  const approved = byName.get("sdk-permission-completed-approved");
  assert.equal(approved.type, "permission");
  assert.equal(approved.status, "completed");
  assert.equal(approved.toolCallId, "sdk-call-4");
  assert.equal(approved.metadata.permissionResult, "approved");

  const denied = byName.get("sdk-permission-completed-denied");
  assert.equal(denied.toolCallId, "req-shell-2", "toolCallId should fall back to requestId");
  assert.equal(denied.metadata.permissionResult, "denied-interactively-by-user");

  const failed = byName.get("sdk-tool-execution-complete-failed");
  assert.equal(failed.type, "tool");
  assert.equal(failed.status, "failed", "data.success === false must flip status, not stay completed");
  assert.equal(failed.metadata.errorCode, "E_TOOL_FAILED");
  assert.equal(typeof failed.metadata.errorClassification, "string");

  const shellExit = byName.get("sdk-tool-execution-complete-shell-exit");
  assert.equal(shellExit.status, "completed", "a non-zero exit code alone must not flip status");
  assert.equal(shellExit.metadata.exitCode, 1);
  assert.equal(shellExit.metadata.bytes, Buffer.byteLength("SECRET-SHELL-OUTPUT-TEXT", "utf8"));

  const hookResult = byName.get("hook-post-tool-use-result");
  assert.equal(hookResult.status, "completed");
  assert.equal(hookResult.metadata.status, "success");
  assert.equal(hookResult.metadata.bytes, Buffer.byteLength("SENTINEL-HOOK-TOOL-RESULT-TEXT", "utf8"));

  const hookRejected = byName.get("hook-post-tool-use-rejected");
  assert.equal(hookRejected.status, "failed", "a non-success hook resultType must flip status");
  assert.equal(hookRejected.metadata.status, "rejected");

  const subagentCompleted = byName.get("sdk-subagent-completed");
  assert.equal(subagentCompleted.type, "agent");
  assert.equal(subagentCompleted.status, "completed");
  assert.equal(subagentCompleted.metadata.durationMs, 4200);
  assert.equal(subagentCompleted.metadata.count, 6, "count should come from totalToolCalls");

  const taskComplete = byName.get("sdk-session-task-complete");
  assert.equal(taskComplete.type, "session");
  assert.equal(taskComplete.status, "task_complete");
  assert.equal(taskComplete.metadata.status, "ok");
});

// T0-G: every free-text / content-bearing argument key `UNSAFE_SNIPPET_KEY`
// adds must be stripped from `snippet`, not just `message`. This bypasses the
// fixture corpus entirely and drives `normalizeHook` directly so the test
// keeps working even if a future edit trims which keys the corpus exercises.
const UNSAFE_ARGUMENT_KEYS = [
  "message", "prompt", "text", "body", "content", "contents", "input",
  "instructions", "description", "notes", "reason", "summary", "response",
  "output", "result", "stdout", "stderr", "diff", "patch", "code", "source",
  "data", "payload", "html", "markdown",
];

function sentinelFor(key) {
  // The trailing "-VALUE" (rather than concatenating straight onto the key)
  // keeps prefix pairs like content/contents from producing sentinels where
  // one is a substring of the other.
  return `SENTINEL-UNSAFE-${key.toUpperCase()}-VALUE`;
}

test("every unsafe argument key is stripped from a hook envelope", () => {
  const toolArgs = Object.fromEntries(UNSAFE_ARGUMENT_KEYS.map(key => [key, sentinelFor(key)]));
  const envelope = normalizeHook("preToolUse", {
    sessionId: "unsafe-key-session",
    timestamp: "2026-08-28T10:00:23.500Z",
    cwd: "/Users/example/worktree",
    toolName: "write_agent",
    toolCallId: "call-unsafe-keys-direct",
    toolArgs,
  }, { client: "copilot-cli", version: "1.0.81-fixture" }, { workspaceRoot: "/Users/example/worktree" });

  const serialized = JSON.stringify(envelope);
  for (const key of UNSAFE_ARGUMENT_KEYS) {
    assert.equal(serialized.includes(sentinelFor(key)), false,
      `envelope leaked the value of the unsafe "${key}" argument`);
  }
  assert.equal(envelope.snippet, "write_agent",
    "snippet should reduce to the bare tool name once every argument key is blocked");
});
