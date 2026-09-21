// Normalizes path-like config values to canonical user paths.
import { isPlainObject, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;

const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

/**
 * Normalize tilde paths in path-like config fields using the config reader's home.
 * Returns a copy with structural sharing; the input config is never mutated, so
 * callers can materialize runtime config without leaking into a shared sourceConfig.
 */
export function normalizeConfigPaths(
  cfg: OpenClawConfig,
  opts?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): OpenClawConfig {
  // Status can read a daemon's config from a different home. Capture that
  // resolution context once so nested paths cannot fall back to the CLI home.
  function normalizeAny(key: string | undefined, value: unknown): unknown {
    if (typeof value === "string") {
      return key &&
        PATH_VALUE_RE.test(value.trim()) &&
        (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key))
        ? resolveUserPath(value, opts?.env, opts?.homedir)
        : value;
    }
    if (Array.isArray(value)) {
      const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
      // Only direct string children of path lists inherit the field's path semantics.
      let changed = false;
      const next = value.map((entry) => {
        const normalized = normalizeAny(
          typeof entry === "string" && normalizeChildren ? key : undefined,
          entry,
        );
        changed ||= normalized !== entry;
        return normalized;
      });
      return changed ? next : value;
    }
    if (isPlainObject(value)) {
      // Clone only along changed branches so callers keep structural sharing and
      // the input config (including shared plugin passthrough subtrees) is never
      // mutated.
      let next: Record<string, unknown> | undefined;
      for (const [childKey, childValue] of Object.entries(value)) {
        const normalized = normalizeAny(childKey, childValue);
        if (normalized !== childValue) {
          next ??= { ...value };
          next[childKey] = normalized;
        }
      }
      return next ?? value;
    }
    return value;
  }
  // normalizeAny preserves every object/array key, so the returned value keeps the
  // input's OpenClawConfig shape.
  // SAFETY: normalization only rewrites path-like string leaves, never object shape.
  return normalizeAny(undefined, cfg) as OpenClawConfig;
}
