import { shellCommandSegments, urlResource } from "./paths.mjs";

// Total intent resources returned per event, mirroring the collector's
// overall 32-resource cap (producer/src/contract.mjs:MAX_EVENT_RESOURCES).
const MAX_INTENT_RESOURCES = 32;

const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "ci", "add", "update"]);
const PNPM_INSTALL_SUBCOMMANDS = new Set(["install", "add", "i", "update"]);
const YARN_INSTALL_SUBCOMMANDS = new Set(["add", "install"]);
const CARGO_INSTALL_SUBCOMMANDS = new Set(["add", "install", "fetch"]);
const BREW_INSTALL_SUBCOMMANDS = new Set(["install", "upgrade"]);

// Package managers resolve to the registry host they would fetch from. `ref`
// is always the registry root; no path is observed for a bare install.
const PACKAGE_MANAGER_RULES = [
  { command: "npm", host: "registry.npmjs.org", match: args => NPM_INSTALL_SUBCOMMANDS.has(args[0]) },
  // Keep simple: any `npx <pkg>` fetches unless the caller opted out.
  { command: "npx", host: "registry.npmjs.org", match: args => args.length > 0 && !args.includes("--no-install") },
  { command: "pnpm", host: "registry.npmjs.org", match: args => PNPM_INSTALL_SUBCOMMANDS.has(args[0]) },
  { command: "yarn", host: "registry.npmjs.org", match: args => YARN_INSTALL_SUBCOMMANDS.has(args[0]) },
  { command: "pip", host: "pypi.org", match: args => args[0] === "install" },
  { command: "pip3", host: "pypi.org", match: args => args[0] === "install" },
  { command: "uv", host: "pypi.org", match: args => (args[0] === "pip" && args[1] === "install") || args[0] === "add" },
  { command: "poetry", host: "pypi.org", match: args => args[0] === "add" || args[0] === "install" },
  { command: "dotnet", host: "api.nuget.org", match: args => (args[0] === "add" && args[1] === "package") || args[0] === "restore" },
  { command: "nuget", host: "api.nuget.org", match: () => true },
  { command: "cargo", host: "crates.io", match: args => CARGO_INSTALL_SUBCOMMANDS.has(args[0]) },
  { command: "go", host: "proxy.golang.org", match: args => args[0] === "get" || (args[0] === "mod" && args[1] === "download") },
  { command: "brew", host: "formulae.brew.sh", match: args => BREW_INSTALL_SUBCOMMANDS.has(args[0]) },
];

// Each rule returns the runner name for a matching segment, or undefined.
const TEST_RULES = [
  segment => (segment.command === "npm" && segment.args[0] === "test") ? "npm" : undefined,
  segment => (segment.command === "npm" && segment.args[0] === "run"
    && typeof segment.args[1] === "string" && segment.args[1].startsWith("test")) ? "npm" : undefined,
  segment => (segment.command === "pnpm" && segment.args[0] === "test") ? "pnpm" : undefined,
  segment => (segment.command === "yarn" && segment.args[0] === "test") ? "yarn" : undefined,
  segment => {
    if (segment.command !== "npx") return undefined;
    const [first, second] = segment.args;
    if (first === "vitest" || first === "jest" || first === "mocha") return first;
    if (first === "playwright" && second === "test") return "playwright";
    return undefined;
  },
  segment => segment.command === "pytest" ? "pytest" : undefined,
  segment => {
    if (segment.command !== "python" && segment.command !== "python3") return undefined;
    const [flag, module] = segment.args;
    return flag === "-m" && (module === "pytest" || module === "unittest") ? module : undefined;
  },
  segment => (segment.command === "dotnet" && segment.args[0] === "test") ? "dotnet" : undefined,
  segment => (segment.command === "go" && segment.args[0] === "test") ? "go" : undefined,
  segment => (segment.command === "cargo" && segment.args[0] === "test") ? "cargo" : undefined,
  segment => (segment.command === "clojure" && segment.args.some(arg => /^-M:.*test/i.test(arg))) ? "clojure" : undefined,
  segment => (segment.command === "lein" && segment.args[0] === "test") ? "lein" : undefined,
  segment => (segment.command === "mvn" && segment.args[0] === "test") ? "mvn" : undefined,
  segment => (segment.command === "gradle" && segment.args[0] === "test") ? "gradle" : undefined,
];

// Each rule returns the build tool name for a matching segment, or undefined.
const BUILD_RULES = [
  segment => (segment.command === "npm" && segment.args[0] === "run" && segment.args[1] === "build") ? "npm" : undefined,
  segment => (segment.command === "pnpm" && segment.args[0] === "build") ? "pnpm" : undefined,
  segment => (segment.command === "vite" && segment.args[0] === "build") ? "vite" : undefined,
  segment => segment.command === "tsc" ? "tsc" : undefined,
  segment => (segment.command === "dotnet" && ["build", "publish"].includes(segment.args[0])) ? "dotnet" : undefined,
  segment => (segment.command === "cargo" && segment.args[0] === "build") ? "cargo" : undefined,
  segment => (segment.command === "go" && segment.args[0] === "build") ? "go" : undefined,
  segment => segment.command === "make" ? "make" : undefined,
  segment => (segment.command === "gradle" && ["build", "assemble"].includes(segment.args[0])) ? "gradle" : undefined,
  segment => (segment.command === "mvn" && ["package", "compile"].includes(segment.args[0])) ? "mvn" : undefined,
];

const GIT_NETWORK_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);
// Git subcommands are always lowercase alphabetic-with-hyphens; anything else
// is dropped rather than emitted as an unbounded/unexpected `name`.
const GIT_NAME_PATTERN = /^[a-z-]{1,32}$/;

// Recognizes curl/wget/httpie/xh/Invoke-WebRequest/etc. by construction: any
// argv token in any command that parses as an absolute http(s)/ws(s) URL is a
// network target, regardless of which command carries it.
function networkFamily(segments) {
  const resources = [];
  for (const segment of segments) {
    for (const token of segment.args) {
      const resource = urlResource(token, segment.command);
      if (resource) resources.push(resource);
    }
  }
  return resources;
}

function packageManagerFamily(segments) {
  const resources = [];
  for (const segment of segments) {
    const rule = PACKAGE_MANAGER_RULES.find(candidate => candidate.command === segment.command);
    if (!rule || !rule.match(segment.args)) continue;
    resources.push({
      kind: "url",
      name: rule.host,
      ref: `https://${rule.host}/`,
      provider: segment.command,
      action: "network",
      confidence: "inferred",
    });
  }
  return resources;
}

function testsFamily(segments) {
  const resources = [];
  for (const segment of segments) {
    for (const rule of TEST_RULES) {
      const runner = rule(segment);
      if (runner) {
        resources.push({ kind: "tests", name: runner, action: "execute", confidence: "inferred" });
        break;
      }
    }
  }
  return resources;
}

function gitFamily(segments) {
  const resources = [];
  for (const segment of segments) {
    if (segment.command !== "git") continue;
    const subcommand = segment.args[0];
    if (typeof subcommand !== "string" || !GIT_NAME_PATTERN.test(subcommand)) continue;
    resources.push({
      kind: "git",
      name: subcommand,
      action: GIT_NETWORK_SUBCOMMANDS.has(subcommand) ? "network" : "execute",
      confidence: "inferred",
    });
  }
  return resources;
}

function buildFamily(segments) {
  const resources = [];
  for (const segment of segments) {
    for (const rule of BUILD_RULES) {
      const tool = rule(segment);
      if (tool) {
        resources.push({ kind: "build", name: tool, action: "execute", confidence: "inferred" });
        break;
      }
    }
  }
  return resources;
}

// Precedence order: network first, then the command families in the order
// they were specified. Results are concatenated in this order before the
// dedupe + cap pass, so network resources are the ones kept when an event is
// busy enough to hit the cap.
const FAMILIES = [networkFamily, packageManagerFamily, testsFamily, gitFamily, buildFamily];

function dedupeResources(resources) {
  const seenRefs = new Set();
  const seenKeys = new Set();
  const result = [];
  for (const resource of resources) {
    if (resource.kind === "url") {
      // Dedupe by ref alone: the same URL curled and wget'd in one event is
      // one target, even though the two calls have different providers.
      if (seenRefs.has(resource.ref)) continue;
      seenRefs.add(resource.ref);
    } else {
      const key = `${resource.kind}:${resource.name}:${resource.action}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    result.push(resource);
  }
  return result;
}

/**
 * Recognize network targets and command-family intent (tests, package
 * managers, git, build) from the shell command(s) embedded in a producer
 * event payload. `value` is the same raw event data `inferredShellResources`
 * and `inferredPatchResources` in paths.mjs receive.
 *
 * Every returned resource is exactly the bounded shape the collector already
 * accepts: a subset of {kind, name, ref, provider, action, confidence}.
 * Nothing here ever emits raw command text, arguments, or output.
 */
export function intentResourcesFor(value) {
  const segments = shellCommandSegments(value);
  if (!segments.length) return [];
  const resources = FAMILIES.flatMap(family => family(segments));
  return dedupeResources(resources).slice(0, MAX_INTENT_RESOURCES);
}
