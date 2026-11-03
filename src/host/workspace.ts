/**
 * Where the records live: workspace and profile-manifest discovery.
 *
 * The plugin must run on a machine that is NOT this one. A compiled-in
 * `C:\Users\...` literal is not a default, it is a defect: on another host it
 * makes the first run write its artifact into a directory tree that does not
 * exist (or worse, silently creates one) and makes every check read the wrong
 * files. So the workspace is DISCOVERED, in a stated order, and the order is
 * part of the contract:
 *
 * 1. `DSH_META_RESEARCH_WORKSPACE`, when set — an explicit answer always wins.
 * 2. A program workspace seen from the current directory: the nearest ancestor
 *    that carries `AGENTS.md`, `plan/` and `research/`.
 * 3. A program workspace beside the harness: for each ancestor, a
 *    `<ancestor>/profiles-tree/<tier>/<name>` directory with the same three
 *    markers. This is how a clone under `plugins-src/` finds the workspace the
 *    program actually keeps its records in.
 * 4. The current directory, unchanged and unrescued — a wrong answer that is
 *    REPORTED by the checks rather than a fabricated one.
 *
 * Step 3 is the one that makes an install with no manual steps work: it needs no
 * configuration, and it is a SEARCH, not a guess, because the markers are the
 * thing being searched for.
 *
 * @module dsh-meta-research/host/workspace
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's own directory, used as a second search seed. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** True when `dir` is a program workspace: the three markers this census reads. */
export function isProgramWorkspace(dir: string): boolean {
  try {
    return (
      statSync(dir).isDirectory() &&
      existsSync(join(dir, 'AGENTS.md')) &&
      existsSync(join(dir, 'plan')) &&
      existsSync(join(dir, 'research'))
    )
  } catch {
    return false
  }
}

/** `dir` and every ancestor of it, nearest first. */
function ancestors(dir: string): string[] {
  const out: string[] = []
  let current = resolve(dir)
  for (;;) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/** Directory names under `dir`, sorted, or `[]` when it is unreadable. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** The first program workspace under `<ancestor>/profiles-tree/<tier>/<name>`, or null. */
function scanProfilesTree(ancestor: string): string | null {
  const root = join(ancestor, 'profiles-tree')
  for (const tier of listDir(root)) {
    for (const name of listDir(join(root, tier))) {
      const candidate = join(root, tier, name)
      if (isProgramWorkspace(candidate)) return candidate
    }
  }
  return null
}

/**
 * Discover the program workspace.
 *
 * @param start - the seed directory; defaults to the process working directory.
 * @returns an absolute path. Never empty, never invented: the last resort is the seed.
 */
export function discoverWorkspace(start?: string): string {
  const fromEnv = process.env.DSH_META_RESEARCH_WORKSPACE
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  const seed = resolve(start ?? process.cwd())
  for (const searchSeed of [seed, MODULE_DIR]) {
    for (const dir of ancestors(searchSeed)) {
      if (isProgramWorkspace(dir)) return dir
      const found = scanProfilesTree(dir)
      if (found !== null) return found
    }
  }
  return seed
}

/**
 * The profile manifest this census reads, discovered rather than compiled in.
 *
 * Order: `DSH_PROFILE_MANIFEST`; the first ancestor of the workspace's PARENT
 * that carries a `package.json` (a program workspace that lives inside a profile
 * gets that profile's manifest); otherwise the parent's `package.json` path, so
 * the check reports it unreadable rather than reading some unrelated file.
 */
export function findProfileManifest(workspaceDir: string): string {
  const fromEnv = process.env.DSH_PROFILE_MANIFEST
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  const parent = dirname(resolve(workspaceDir))
  for (const dir of ancestors(parent)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) return manifest
  }
  return join(parent, 'package.json')
}
