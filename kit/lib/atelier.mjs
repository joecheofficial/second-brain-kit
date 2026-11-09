// Run the Atelier package installed inside the brain, with this same Node.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const ATELIER_VERSION = '0.2.0-alpha.23'
export const NODE_RANGE = '>=22.18.0 <23 || >=24.13.1 <25'

export function nodeSupported(version = process.versions.node) {
  const [maj, min, pat] = version.split('.').map(Number)
  const atLeast = (a, b, c) => min > b || (min === b && pat >= c)
  if (maj === 22) return atLeast(22, 18, 0)
  if (maj === 24) return atLeast(24, 13, 1)
  return false
}

export function atelierEntry(root) {
  return path.join(root, 'node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs')
}

export function installedVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@mnstry', 'atelier', 'package.json'), 'utf8')).version
  } catch { return null }
}

export function atelier(root, args, { input, timeoutMs = 15 * 60_000 } = {}) {
  const entry = atelierEntry(root)
  if (!fs.existsSync(entry)) return { ok: false, code: null, stdout: '', stderr: 'Atelier is not installed here. Run: npm install' }
  const env = { ...process.env }
  // A Git editor or hooks path from the person's shell must not change Atelier's own Git reads.
  delete env.GIT_EDITOR
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, input, encoding: 'utf8', env, maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs })
  return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') }
}
