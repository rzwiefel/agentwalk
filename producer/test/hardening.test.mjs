import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BoundedSpool } from "../src/spool.mjs";
import { SessionEventWatcher } from "../src/session-watcher.mjs";

// Covers roadmap.md P1-11 (corrupt spool lines vanish silently) and P1-12
// (a blanket readdir catch hides EACCES as "no sessions"). Kept separate from
// producer.test.mjs, which is owned by another agent.

const testRoot = path.join(process.cwd(), ".test-work-hardening");

test.beforeEach(async () => fs.rm(testRoot, { recursive: true, force: true }));
test.after(async () => fs.rm(testRoot, { recursive: true, force: true }));

test("corrupt spool lines are dropped, counted, and recorded without content", async () => {
  const spoolDir = path.join(testRoot, "spool");
  const runtimeDir = path.join(testRoot, "runtime");
  await fs.mkdir(spoolDir, { recursive: true });
  const lines = [
    JSON.stringify({ id: "good-1", timestamp: "2026-08-30T00:00:00.000Z", secret: "SHOULD_NOT_LEAK" }),
    "{ this is not valid json",
    JSON.stringify({ id: "good-2", timestamp: "2026-08-30T00:00:01.000Z" }),
  ];
  await fs.writeFile(path.join(spoolDir, "events.jsonl"), `${lines.join("\n")}\n`);

  const spool = new BoundedSpool(spoolDir, { runtimeDir });
  const events = await spool.read();

  assert.deepEqual(events.map(event => event.id), ["good-1", "good-2"]);
  assert.equal(spool.lastDroppedLines, 1);

  const diagnostic = await fs.readFile(path.join(runtimeDir, "spool-diagnostics.log"), "utf8");
  assert.match(diagnostic, /"droppedLines":1/);
  assert.equal(diagnostic.includes("SHOULD_NOT_LEAK"), false);
  assert.equal(diagnostic.includes("good-1"), false);
  const stat = await fs.stat(path.join(runtimeDir, "spool-diagnostics.log"));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("a clean spool read never touches the diagnostics log", async () => {
  const spoolDir = path.join(testRoot, "spool-clean");
  const runtimeDir = path.join(testRoot, "runtime-clean");
  const spool = new BoundedSpool(spoolDir, { runtimeDir });
  await spool.append({ id: "only", timestamp: "2026-08-30T00:00:00.000Z" });

  const events = await spool.read();

  assert.equal(events.length, 1);
  assert.equal(spool.lastDroppedLines, 0);
  await assert.rejects(fs.stat(path.join(runtimeDir, "spool-diagnostics.log")), /ENOENT/);
});

test("session watcher discover() treats a missing session-state directory as no sessions", async () => {
  const events = [];
  const watcher = new SessionEventWatcher({
    sessionStateDirectory: path.join(testRoot, "does-not-exist"),
    workspaceRoot: path.join(testRoot, "workspace-missing"),
    onEvent: event => events.push(event),
  });

  assert.equal(await watcher.discover(), undefined);
  await watcher.poll();
  assert.deepEqual(events, []);
});

test("session watcher discover() surfaces a permission error instead of reporting no sessions", async () => {
  const sessions = path.join(testRoot, "session-state-blocked");
  await fs.mkdir(sessions, { recursive: true });
  await fs.chmod(sessions, 0o000);
  try {
    const events = [];
    const watcher = new SessionEventWatcher({
      sessionStateDirectory: sessions,
      workspaceRoot: path.join(testRoot, "workspace-blocked"),
      onEvent: event => events.push(event),
    });

    await assert.rejects(watcher.discover(), error => error.code === "EACCES");
    await assert.rejects(watcher.poll(), error => error.code === "EACCES");
    assert.deepEqual(events, []);
  } finally {
    // Restore permissions so the shared testRoot cleanup (which recursively
    // reads this directory) does not itself fail with EACCES.
    await fs.chmod(sessions, 0o700);
  }
});
