import fs from "node:fs";
import path from "node:path";
import { intentResourcesFor } from "./intent.mjs";

const PATH_KEYS = /^(?:path|filePath|file|filename|uri|directory|dir|cwd|workspace)$/i;
const SEARCH_COMMANDS = new Set(["rg", "ripgrep", "grep", "find", "fd", "fdfind"]);
const CHAIN_OPERATORS = new Set(["|", "||", "&&", ";", "&"]);
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "sudo"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NETWORK_URL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const NETWORK_HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/;
const MAX_URL_REF_LENGTH = 512;
const MAX_URL_NAME_LENGTH = 256;

function realpath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function normalizeResourcePath(value, workspaceRoot) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!workspaceRoot) {
    return {
      path: path.normalize(value).split(path.sep).join("/"),
      action: "reference",
      confidence: "observed",
    };
  }
  const root = realpath(workspaceRoot);
  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  let current = candidate;
  const missingTail = [];
  let exact = true;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { stat = undefined; }
    if (stat) break;
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    missingTail.unshift(path.basename(current));
    current = parent;
    exact = false;
  }
  // realpath on the nearest existing ancestor validates every existing
  // ancestor, including a symlink that appears before a missing target.
  const resolvedBase = realpath(current);
  const resolvedCandidate = path.join(resolvedBase, ...missingTail);
  if (!isWithin(root, resolvedBase)) {
    return {
      path: resolvedCandidate.split(path.sep).join("/"),
      action: "reference",
      confidence: "observed",
      outsideRoot: true,
    };
  }
  if (!isWithin(root, resolvedCandidate)) {
    return {
      path: resolvedCandidate.split(path.sep).join("/"),
      action: "reference",
      confidence: "observed",
      outsideRoot: true,
    };
  }
  const relative = path.relative(root, resolvedCandidate);
  return {
    path: relative.split(path.sep).join("/"),
    action: "reference",
    confidence: exact ? "exact" : "observed",
  };
}

/**
 * Sanitize a raw string into a bounded `kind:'url'` network resource when it
 * parses as an absolute http(s)/ws(s) URL. Strips userinfo, query, and
 * fragment; keeps the port only when it differs from the scheme default; caps
 * `ref`/`name` at the collector's bounds. Returns undefined for anything that
 * is not a recognized network URL so callers can fall back to path handling.
 */
export function urlResource(rawValue, provider) {
  if (typeof rawValue !== "string" || !rawValue.trim()) return undefined;
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    return undefined;
  }
  if (!NETWORK_URL_SCHEMES.has(url.protocol)) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return undefined;
  const defaultPort = url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
  const hostWithPort = url.port && url.port !== defaultPort ? `${hostname}:${url.port}` : hostname;
  if (!NETWORK_HOST_PATTERN.test(hostWithPort)) return undefined;
  const ref = `${url.protocol}//${hostWithPort}${url.pathname}`;
  if (ref.length > MAX_URL_REF_LENGTH) return undefined;
  const providerName = typeof provider === "string" ? commandName(provider) : "";
  return {
    kind: "url",
    name: hostWithPort.slice(0, MAX_URL_NAME_LENGTH),
    ref,
    ...(providerName ? { provider: providerName } : {}),
    action: "network",
    confidence: "inferred",
  };
}

function actionForKey(key, toolName = "") {
  if (/search|grep|glob|find|query/i.test(`${key} ${toolName}`)) return "search";
  if (/write|edit|create|patch|delete|remove|move|rename/i.test(`${key} ${toolName}`)) return "write";
  if (/read|view|file|list|glob|grep|search|find/i.test(`${key} ${toolName}`)) return "read";
  return "reference";
}

export function resourcesFrom(value, workspaceRoot, toolName = "", depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value && parsed !== null && typeof parsed === "object") {
        return resourcesFrom(parsed, workspaceRoot, toolName, depth + 1, seen);
      }
    } catch {
      // A plain string is a path, not a JSON container.
    }
    const result = normalizeResourcePath(value, workspaceRoot);
    return result ? [result] : [];
  }
  if (typeof value !== "object" || seen.has(value)) return [];
  if (Array.isArray(value)) {
    return value.flatMap(item => resourcesFrom(item, workspaceRoot, toolName, depth + 1, seen)).slice(0, 32);
  }
  seen.add(value);
  const resources = [];
  for (const [key, item] of Object.entries(value)) {
    if (PATH_KEYS.test(key) && typeof item === "string") {
      // An http(s)/ws(s) URL under a path-shaped key (e.g. an MCP tool's
      // `uri` argument) must become a network resource, never a mangled
      // local path built from a URL string.
      const network = urlResource(item, toolName);
      if (network) {
        resources.push(network);
      } else {
        const resource = normalizeResourcePath(item, workspaceRoot);
        if (resource) resources.push({ ...resource, action: actionForKey(key, toolName) });
      }
    } else if (typeof item === "object") {
      resources.push(...resourcesFrom(item, workspaceRoot, toolName, depth + 1, seen));
    }
  }
  return resources.slice(0, 32);
}

// Quoted strings first (so an operator-looking sequence inside quotes stays
// part of the argument), then the two-character chain operators (longest
// match first), then ordinary words, then a lone chain-operator character.
// Without the trailing alternatives, `|`/`;`/`&` are only ever a word
// boundary and never survive as tokens themselves, so callers that split on
// them (shellCommandSegments below) would never actually see a boundary.
export function shellTokens(value) {
  return String(value).match(/"[^"]*"|'[^']*'|&&|\|\||[^\s|;&]+|[|;&]/g)
    ?.map(token => token.replace(/^["']|["']$/g, "")) ?? [];
}

export function commandName(value) {
  return String(value).replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function searchCommandTargets(command, args) {
  const positional = [];
  let endOptions = false;
  let patternFromOption = false;
  const valueOptions = new Set(["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "-e", "-f", "-g", "-t"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!endOptions && value === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && value.startsWith("-")) {
      if (valueOptions.has(value)) {
        if (value === "-e" || value === "-f" || value === "--regexp" || value === "--file") patternFromOption = true;
        index += 1;
      }
      continue;
    }
    positional.push(value);
  }
  if (command === "find") return positional.length ? positional : ["."];
  if (command === "fd" || command === "fdfind") return positional.slice(1);
  return patternFromOption ? positional : positional.slice(1);
}

function structuredInputs(value) {
  const inputs = [];
  const visit = (candidate, depth = 0) => {
    if (depth > 2 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") visit(parsed, depth + 1);
      } catch {
        // Plain strings are handled by the caller as commands or patches.
      }
      return;
    }
    if (typeof candidate !== "object" || Array.isArray(candidate) || inputs.includes(candidate)) return;
    inputs.push(candidate);
    for (const key of ["toolArgs", "toolArguments", "arguments", "args", "parameters"]) visit(candidate[key], depth + 1);
  };
  visit(value);
  return inputs;
}

export function shellCommandSources(value) {
  return structuredInputs(value)
    .flatMap(input => [input.command, input.cmd, input.shellCommand, input.commandLine])
    .filter(item => typeof item === "string" && item.trim());
}

/**
 * Split every extracted shell command source into chained segments (on
 * `| || && ; &`), skipping leading env-var assignments and `env`/`command`/
 * `exec`/`sudo` wrappers to find the real command. Shared by the search-path
 * walk below and by producer/src/intent.mjs's command-family parsers, so
 * there is exactly one shell lexer.
 */
export function shellCommandSegments(value) {
  const segments = [];
  for (const source of shellCommandSources(value)) {
    const tokens = shellTokens(source);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const position = current.findIndex(token => !COMMAND_WRAPPERS.has(token) && !ENV_ASSIGNMENT.test(token));
      if (position >= 0) segments.push({ command: commandName(current[position]), args: current.slice(position + 1) });
      current = [];
    };
    for (const token of tokens) {
      if (CHAIN_OPERATORS.has(token)) flush();
      else current.push(token);
    }
    flush();
  }
  return segments;
}

function inferredShellResources(value, workspaceRoot) {
  const resources = [];
  for (const segment of shellCommandSegments(value)) {
    if (!SEARCH_COMMANDS.has(segment.command)) continue;
    searchCommandTargets(segment.command, segment.args).forEach(target => {
      if (target !== ".") {
        const resource = normalizeResourcePath(target, workspaceRoot);
        if (resource?.path) resources.push({ ...resource, kind: "directory", action: "search" });
      }
    });
  }
  return resources;
}

function inferredPatchResources(value, workspaceRoot, toolName) {
  const normalizedTool = commandName(toolName);
  const inputs = structuredInputs(value);
  const sources = inputs.flatMap(input => Object.entries(input)
    .filter(([key, item]) => /patch|diff/i.test(key) && typeof item === "string")
    .map(([, item]) => item));
  if (/apply[-_]?patch|patch/.test(normalizedTool)) {
    inputs.forEach(input => {
      for (const key of ["input", "arguments", "toolArgs", "toolArguments"]) {
        if (typeof input[key] === "string") sources.push(input[key]);
      }
    });
  }
  const resources = [];
  sources.forEach(source => {
    source.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\*\*\*\s+(?:Add|Delete|Update|Move to)\s+File:\s*(.+?)\s*$/)
        ?? line.match(/^(?:---|\+\+\+)\s+(.+?)(?:\s+\d+)?$/);
      if (!match) return;
      const file = match[1].replace(/^(?:a|b)\//, "").trim();
      if (!file || file === "/dev/null") return;
      const resource = normalizeResourcePath(file, workspaceRoot);
      if (resource?.path) resources.push({ ...resource, kind: "file", action: "write" });
    });
  });
  return resources;
}

function resourceDedupeKey(resource) {
  if (resource.path !== undefined) return `${resource.path}:${resource.kind}:${resource.action}`;
  if (resource.kind === "url") return `url:${resource.ref}`;
  return `${resource.kind}:${resource.name}:${resource.action}`;
}

export function inferredActivityResources(value, workspaceRoot, toolName = "") {
  const resources = [
    ...inferredShellResources(value, workspaceRoot, toolName),
    ...inferredPatchResources(value, workspaceRoot, toolName),
    ...intentResourcesFor(value),
  ];
  const seen = new Set();
  return resources.filter(resource => {
    const key = resourceDedupeKey(resource);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}
