import assert from "node:assert/strict";
import test from "node:test";
import { intentResourcesFor } from "../src/intent.mjs";
import { inferredActivityResources, resourcesFrom } from "../src/paths.mjs";

const ALLOWED_RESOURCE_KEYS = new Set(["kind", "name", "ref", "provider", "action", "confidence"]);

function assertAllowedKeys(resources, label) {
  for (const resource of resources) {
    for (const key of Object.keys(resource)) {
      assert.ok(ALLOWED_RESOURCE_KEYS.has(key), `${label ?? ""} produced unexpected resource key "${key}"`);
    }
  }
}

test("returns no resources when there is no shell command to parse", () => {
  assert.deepEqual(intentResourcesFor({}), []);
  assert.deepEqual(intentResourcesFor({ path: "src/a.ts" }), []);
  assert.deepEqual(intentResourcesFor(null), []);
});

// --- network family -------------------------------------------------------

test("curl, wget, httpie, and PowerShell web commands produce a url resource", () => {
  assert.deepEqual(intentResourcesFor({ command: "curl https://api.example.com/resource" }), [{
    kind: "url", name: "api.example.com", ref: "https://api.example.com/resource",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "wget http://example.org/file.tar.gz" }), [{
    kind: "url", name: "example.org", ref: "http://example.org/file.tar.gz",
    provider: "wget", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "http GET https://api.example.com/v1/users" }), [{
    kind: "url", name: "api.example.com", ref: "https://api.example.com/v1/users",
    provider: "http", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "xh https://api.example.com/v1/ping" }), [{
    kind: "url", name: "api.example.com", ref: "https://api.example.com/v1/ping",
    provider: "xh", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "Invoke-WebRequest -Uri https://example.com/data.json" }), [{
    kind: "url", name: "example.com", ref: "https://example.com/data.json",
    provider: "invoke-webrequest", action: "network", confidence: "inferred",
  }]);
});

test("any argv token that parses as a network URL counts, regardless of command", () => {
  // Not in any named list of network tools, but still carries a URL token.
  assert.deepEqual(intentResourcesFor({ command: "some-custom-tool --target https://api.example.com/hook" }), [{
    kind: "url", name: "api.example.com", ref: "https://api.example.com/hook",
    provider: "some-custom-tool", action: "network", confidence: "inferred",
  }]);
});

// --- URL sanitisation -------------------------------------------------------

test("network family strips query, fragment, and userinfo from the ref", () => {
  const resources = intentResourcesFor({ command: 'curl "https://user:pass@example.com/path?query=1#frag"' });
  assert.deepEqual(resources, [{
    kind: "url", name: "example.com", ref: "https://example.com/path",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
});

test("network family keeps a non-default port and omits the default port", () => {
  assert.deepEqual(intentResourcesFor({ command: "curl http://example.com:8080/api" }), [{
    kind: "url", name: "example.com:8080", ref: "http://example.com:8080/api",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "curl https://example.com:443/api" }), [{
    kind: "url", name: "example.com", ref: "https://example.com/api",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
});

test("network family recognizes ws and wss schemes", () => {
  assert.deepEqual(intentResourcesFor({ command: "wscat -c wss://example.com/socket" }), [{
    kind: "url", name: "example.com", ref: "wss://example.com/socket",
    provider: "wscat", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "wscat -c ws://example.com:8080/socket" }), [{
    kind: "url", name: "example.com:8080", ref: "ws://example.com:8080/socket",
    provider: "wscat", action: "network", confidence: "inferred",
  }]);
});

test("network family ignores tokens that are not absolute network URLs", () => {
  assert.deepEqual(intentResourcesFor({ command: "curl not-a-url" }), []);
  assert.deepEqual(intentResourcesFor({ command: "curl ftp://example.com/file" }), []);
  assert.deepEqual(intentResourcesFor({ command: "curl file:///etc/passwd" }), []);
});

test("network family keeps localhost and loopback hosts", () => {
  assert.deepEqual(intentResourcesFor({ command: "curl http://localhost:5173/" }), [{
    kind: "url", name: "localhost:5173", ref: "http://localhost:5173/",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "curl http://127.0.0.1:8080/health" }), [{
    kind: "url", name: "127.0.0.1:8080", ref: "http://127.0.0.1:8080/health",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "curl http://localhost/" }), [{
    kind: "url", name: "localhost", ref: "http://localhost/",
    provider: "curl", action: "network", confidence: "inferred",
  }]);
});

test("network family keeps a ref exactly at the 512-character bound and drops one over it", () => {
  const prefix = "https://example.com";
  const atBound = "a".repeat(512 - prefix.length - 1); // -1 accounts for the leading "/"
  const overBound = "a".repeat(512 - prefix.length);
  const kept = intentResourcesFor({ command: `curl ${prefix}/${atBound}` });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ref.length, 512);
  assert.deepEqual(intentResourcesFor({ command: `curl ${prefix}/${overBound}` }), []);
});

// --- package managers -------------------------------------------------------

test("package managers resolve to their registry host as a network resource", () => {
  const cases = [
    ["npm install left-pad", "registry.npmjs.org", "npm"],
    ["npx cowsay hello", "registry.npmjs.org", "npx"],
    ["pnpm add react", "registry.npmjs.org", "pnpm"],
    ["pnpm update", "registry.npmjs.org", "pnpm"],
    ["yarn add react", "registry.npmjs.org", "yarn"],
    ["pip install requests", "pypi.org", "pip"],
    ["pip3 install requests", "pypi.org", "pip3"],
    ["uv pip install requests", "pypi.org", "uv"],
    ["uv add requests", "pypi.org", "uv"],
    ["poetry add requests", "pypi.org", "poetry"],
    ["poetry install", "pypi.org", "poetry"],
    ["dotnet add package Newtonsoft.Json", "api.nuget.org", "dotnet"],
    ["dotnet restore", "api.nuget.org", "dotnet"],
    ["nuget list", "api.nuget.org", "nuget"],
    ["cargo add serde", "crates.io", "cargo"],
    ["cargo install ripgrep", "crates.io", "cargo"],
    ["go get github.com/pkg/errors", "proxy.golang.org", "go"],
    ["go mod download", "proxy.golang.org", "go"],
    ["brew install wget", "formulae.brew.sh", "brew"],
    ["brew upgrade", "formulae.brew.sh", "brew"],
  ];
  for (const [command, host, provider] of cases) {
    assert.deepEqual(intentResourcesFor({ command }), [{
      kind: "url", name: host, ref: `https://${host}/`,
      provider, action: "network", confidence: "inferred",
    }], command);
  }
});

test("npx with --no-install does not count as a registry fetch", () => {
  assert.deepEqual(intentResourcesFor({ command: "npx --no-install vitest" }), []);
});

test("npm subcommands outside the install family do not trigger the package-manager rule", () => {
  assert.deepEqual(intentResourcesFor({ command: "npm run build" }), [
    { kind: "build", name: "npm", action: "execute", confidence: "inferred" },
  ]);
});

// --- tests -------------------------------------------------------------

test("recognized test runners map to a bounded tests resource", () => {
  const cases = [
    ["npm test", "npm"],
    ["npm run test", "npm"],
    ["npm run test:unit", "npm"],
    ["pnpm test", "pnpm"],
    ["yarn test", "yarn"],
    ["pytest", "pytest"],
    ["python -m pytest", "pytest"],
    ["python -m unittest", "unittest"],
    ["python3 -m pytest", "pytest"],
    ["dotnet test", "dotnet"],
    ["go test ./...", "go"],
    ["cargo test", "cargo"],
    ["clojure -M:test", "clojure"],
    ["lein test", "lein"],
    ["mvn test", "mvn"],
    ["gradle test", "gradle"],
  ];
  for (const [command, runner] of cases) {
    assert.deepEqual(intentResourcesFor({ command }), [
      { kind: "tests", name: runner, action: "execute", confidence: "inferred" },
    ], command);
  }
});

test("npx test runners also produce the npm registry fetch alongside their tests resource", () => {
  for (const [command, runner] of [
    ["npx vitest", "vitest"],
    ["npx jest", "jest"],
    ["npx mocha", "mocha"],
    ["npx playwright test", "playwright"],
  ]) {
    const resources = intentResourcesFor({ command });
    assert.equal(resources.length, 2, command);
    assert.ok(resources.some(r => r.kind === "tests" && r.name === runner), command);
    assert.ok(resources.some(r => r.kind === "url" && r.name === "registry.npmjs.org"), command);
  }
});

// --- git -------------------------------------------------------------

test("git network subcommands are tagged action:network, others action:execute", () => {
  for (const subcommand of ["push", "pull", "fetch", "ls-remote"]) {
    assert.deepEqual(intentResourcesFor({ command: `git ${subcommand} origin` }), [
      { kind: "git", name: subcommand, action: "network", confidence: "inferred" },
    ], subcommand);
  }
  for (const subcommand of ["status", "commit", "log", "diff"]) {
    assert.deepEqual(intentResourcesFor({ command: `git ${subcommand}` }), [
      { kind: "git", name: subcommand, action: "execute", confidence: "inferred" },
    ], subcommand);
  }
});

test("git clone also yields the target url alongside the git action", () => {
  assert.deepEqual(intentResourcesFor({ command: "git clone https://github.com/user/repo.git" }), [
    {
      kind: "url", name: "github.com", ref: "https://github.com/user/repo.git",
      provider: "git", action: "network", confidence: "inferred",
    },
    { kind: "git", name: "clone", action: "network", confidence: "inferred" },
  ]);
});

test("git subcommands that do not match the bounded name pattern are dropped", () => {
  assert.deepEqual(intentResourcesFor({ command: "git -C /tmp status" }), []);
});

// --- build -------------------------------------------------------------

test("recognized build commands map to a bounded build resource", () => {
  const cases = [
    ["npm run build", "npm"],
    ["pnpm build", "pnpm"],
    ["vite build", "vite"],
    ["tsc", "tsc"],
    ["tsc --noEmit", "tsc"],
    ["dotnet build", "dotnet"],
    ["dotnet publish", "dotnet"],
    ["cargo build", "cargo"],
    ["go build ./...", "go"],
    ["make", "make"],
    ["make all", "make"],
    ["gradle build", "gradle"],
    ["gradle assemble", "gradle"],
    ["mvn package", "mvn"],
    ["mvn compile", "mvn"],
  ];
  for (const [command, tool] of cases) {
    assert.deepEqual(intentResourcesFor({ command }), [
      { kind: "build", name: tool, action: "execute", confidence: "inferred" },
    ], command);
  }
});

// --- chained commands, dedupe, cap -------------------------------------

test("chained commands yield resources from each segment", () => {
  const resources = intentResourcesFor({ command: "curl https://a.example.com/x && npm test && git push" });
  assert.equal(resources.length, 3);
  assert.ok(resources.some(r => r.kind === "url" && r.name === "a.example.com"));
  assert.ok(resources.some(r => r.kind === "tests" && r.name === "npm"));
  assert.ok(resources.some(r => r.kind === "git" && r.name === "push" && r.action === "network"));
});

test("semicolon, pipe, and or-chains also split into independent segments", () => {
  assert.equal(intentResourcesFor({ command: "npm test; git push" }).length, 2);
  assert.equal(intentResourcesFor({ command: "cargo build || cargo test" }).length, 2);
  assert.equal(intentResourcesFor({ command: "curl https://example.com/data.json | jq ." }).length, 1);
});

test("env-var prefixes and sudo/env/exec wrappers are skipped to find the real command", () => {
  assert.deepEqual(intentResourcesFor({ command: "sudo npm install -g typescript" }), [{
    kind: "url", name: "registry.npmjs.org", ref: "https://registry.npmjs.org/",
    provider: "npm", action: "network", confidence: "inferred",
  }]);
  assert.deepEqual(intentResourcesFor({ command: "CI=true npm test" }), [
    { kind: "tests", name: "npm", action: "execute", confidence: "inferred" },
  ]);
});

test("identical resources are deduped within one event", () => {
  assert.equal(intentResourcesFor({
    command: "curl https://api.example.com/x && curl https://api.example.com/x",
  }).length, 1);
  assert.equal(intentResourcesFor({ command: "npm test && npm test" }).length, 1);
  // Same host reached by two different providers still collapses to one ref.
  assert.equal(intentResourcesFor({
    command: "curl https://api.example.com/x && wget https://api.example.com/x",
  }).length, 1);
});

test("intent resources are capped at 32 per event", () => {
  const manyUrls = Array.from({ length: 40 }, (_, index) => `curl https://host${index}.example.com/`).join(" && ");
  const resources = intentResourcesFor({ command: manyUrls });
  assert.equal(resources.length, 32);
});

// --- key allowlist and redaction -------------------------------------

test("every emitted resource has only keys from the bounded resource shape", () => {
  const commands = [
    "curl https://api.example.com/x",
    "npm install left-pad",
    "npm test",
    "git push origin main",
    "git status",
    "npm run build",
    "git clone https://github.com/user/repo.git",
    "npx vitest",
  ];
  for (const command of commands) {
    assertAllowedKeys(intentResourcesFor({ command }), command);
  }
});

test("redacts a curled URL down to host, path, and provider only", () => {
  const command = 'curl -H "Authorization: Bearer SENTINEL" '
    + '"https://user:SENTINELPW@api.example.com/v1/x?token=SENTINELQ#frag"';
  const resources = intentResourcesFor({ command });
  assert.deepEqual(resources, [{
    kind: "url",
    name: "api.example.com",
    ref: "https://api.example.com/v1/x",
    provider: "curl",
    action: "network",
    confidence: "inferred",
  }]);
  assert.equal(JSON.stringify(resources).includes("SENTINEL"), false);
});

// --- paths.mjs composition -------------------------------------------

test("inferredActivityResources composes intent resources alongside shell and patch resources", () => {
  const resources = inferredActivityResources(
    { command: "curl https://api.example.com/x && npm test" }, undefined, "bash",
  );
  assert.ok(resources.some(r => r.kind === "url" && r.name === "api.example.com"));
  assert.ok(resources.some(r => r.kind === "tests" && r.name === "npm"));
  assertAllowedKeys(resources.filter(r => r.kind === "url" || r.kind === "tests"));
});

test("inferredActivityResources keeps the total resource cap at 32", () => {
  const manyUrls = Array.from({ length: 40 }, (_, index) => `curl https://host${index}.example.com/`).join(" && ");
  const resources = inferredActivityResources({ command: manyUrls }, undefined, "bash");
  assert.equal(resources.length, 32);
});

test("resourcesFrom turns a URL-shaped path key into a network resource instead of a mangled path", () => {
  const resources = resourcesFrom({ uri: "https://example.com/api" }, "/workspace", "fetch_tool");
  assert.deepEqual(resources, [{
    kind: "url", name: "example.com", ref: "https://example.com/api",
    provider: "fetch_tool", action: "network", confidence: "inferred",
  }]);
});

test("resourcesFrom still resolves ordinary paths under path-shaped keys", () => {
  assert.deepEqual(resourcesFrom({ path: "src/a.ts" }, undefined, "read_file"), [
    { path: "src/a.ts", action: "read", confidence: "observed" },
  ]);
});
