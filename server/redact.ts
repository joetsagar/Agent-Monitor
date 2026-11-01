// Redacts likely secrets from anything stored or shown. Applied to every
// payload before it reaches SQLite or a browser.

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_\-]{10,}/g, "sk-ant-[REDACTED]"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "gh_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "xox-[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',]+/gi, "$1$2[REDACTED]"],
  [/\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',]{6,})/gi, "$1[REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED JWT]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SECRET_KEYS = /^(api[_-]?key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|authorization|cookie)$/i;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return "[depth limit]" as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === "string" ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

// Truncates long strings inside a payload so stored details stay small.
export function truncateDeep<T>(value: T, max = 4000, depth = 0): T {
  if (depth > 12) return "[depth limit]" as unknown as T;
  if (typeof value === "string") {
    return (value.length > max ? value.slice(0, max) + `… [${value.length - max} more chars]` : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, 200).map((v) => truncateDeep(v, max, depth + 1));
    if (value.length > 200) arr.push(`[${value.length - 200} more items]`);
    return arr as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, max, depth + 1);
    return out as T;
  }
  return value;
}

export const sanitize = <T>(v: T, max = 4000): T => truncateDeep(redact(v), max);
