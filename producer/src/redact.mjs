import os from "node:os";

// Exported so other layers (e.g. the frontend's src/activity/redaction.test.ts)
// can assert their own redaction coverage is a superset of this list instead
// of silently drifting from it.
export const SECRET_KEY = /(password|passwd|secret|token|bearer|basic|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?key|prompt|content|result|argument|command|code|environment|env|stack)/i;
const PATH_KEY = /(^|[-_])(path|file|directory|cwd|workspace|root|uri|url)$/i;
const SECRET_VALUE = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
];
export const SENSITIVE_ASSIGNMENT = /(\b(?:Bearer|Basic|Token)\s*(?:[:=]\s*|\s+)|\b(?:authorization|api[-_]?key|access[-_]?key|password|token)\s*[:=]\s*(?!(?:Bearer|Basic|Token)\b))\S+/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+@)+/gi;
const ABSOLUTE_PATH = /(?:\/(?:Users|home|private\/var)\/[^/\s]+(?:\/[^\s]*)?|[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?)/gi;

export function redactString(value, { preservePaths = false } = {}) {
  let output = String(value);
  output = output.replace(URL_USERINFO, "$1");
  output = output.replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]");
  for (const pattern of SECRET_VALUE) output = output.replace(pattern, "[REDACTED]");
  if (preservePaths) return output;
  const home = os.homedir();
  if (home) output = output.split(home).join("[HOME]");
  return output.replace(ABSOLUTE_PATH, "[PATH]");
}

function safeKey(key) {
  return typeof key === "string" && !SECRET_KEY.test(key);
}

/**
 * Keep only bounded, scalar metadata. This intentionally drops content-like
 * fields instead of trying to redact an arbitrary prompt or tool result.
 */
export function redactMetadata(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return redactString(value).slice(0, 256);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => redactMetadata(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!safeKey(key) || PATH_KEY.test(key)) continue;
    const clean = redactMetadata(item, depth + 1);
    if (clean !== undefined) output[key.slice(0, 80)] = clean;
  }
  return output;
}

export function redactError(error) {
  if (!error) return undefined;
  const rawName = typeof error === "string" ? "" : error.name;
  const rawCode = typeof error === "object" ? error.code : undefined;
  const rawContext = typeof error === "object" ? error.errorContext : undefined;
  const classification = typeof rawContext === "string" && /^(model_call|tool_execution|system|user_input)$/.test(rawContext)
    ? rawContext
    : /timeout/i.test(rawName) ? "timeout"
      : /permission|denied|forbidden/i.test(rawName) ? "permission"
        : "error";
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_.-]{1,63}$/i.test(rawCode)
    ? rawCode
    : undefined;
  return {
    classification,
    ...(code ? { code } : {}),
  };
}
