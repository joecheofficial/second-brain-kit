// One front door for the second brain: installs the pinned Organizer and the pinned
// Atelier graph checker, creates the brain, and keeps all three up to date.
// Versions live in kit.json, so a kit update is the only thing that moves them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const KIT = JSON.parse(fs.readFileSync(path.join(KIT_DIR, 'kit.json'), 'utf8'))
const WIN = process.platform === 'win32'
const home = () => process.env.SECOND_BRAIN_KIT_HOME || os.homedir()

export const organizerDir = () => process.env.SECOND_BRAIN_KIT_ORGANIZER || path.join(home(), KIT.organizer.folder)
export const atelierPackageDir = root => path.join(root, '.external', 'atelier', 'node_modules', ...KIT.atelier.package.split('/'))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 600000, cwd: opts.cwd, shell: opts.shell || false })
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() }
}
const git = (args, cwd) => run('git', args, { cwd })
const npm = args => run(WIN ? 'npm.cmd' : 'npm', args, { shell: WIN })

function nodeOk() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  const at = v => v.split('.').map(Number)
  const ge = ([a, b, c]) => major > a || (major === a && (minor > b || (minor === b && patch >= c)))
  if (major === 22) return ge(at(KIT.node.min22))
  if (major === 24) return ge(at(KIT.node.min24))
  return major > 24
}

export function organizerState() {
  const dir = organizerDir()
  if (!fs.existsSync(path.join(dir, 'bin', 'brain.js'))) return { present: false, dir }
  const head = git(['rev-parse', 'HEAD'], dir).out
  const pinned = git(['rev-parse', `${KIT.organizer.ref}^{commit}`], dir).out
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], dir).out
  return { present: true, dir, head, pinned, atPin: !!head && head === pinned, dirty: !!dirty }
}

export function atelierState(root) {
  const pkg = path.join(atelierPackageDir(root), 'package.json')
  if (!fs.existsSync(pkg)) return { present: false }
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version
  const help = run(process.execPath, [path.join(atelierPackageDir(root), 'bin', 'atelier.mjs'), '--help'], { timeout: 60000 })
  return { present: true, version, atPin: version === KIT.atelier.version, runs: help.ok }
}

export function organizer(root, ...args) {
  const r = run(process.execPath, [path.join(organizerDir(), 'bin', 'brain.js'), ...args, '--root', root])
  let json = null
  try { json = JSON.parse(r.out) } catch {}
  return { ...r, json }
}

export function setup({ root }) {
  const steps = []
  const step = (name, ok, detail) => { steps.push({ name, ok, ...(detail ? { detail } : {}) }); return ok }
  const done = () => ({ ok: steps.every(s => s.ok), root, organizer: organizerDir(), steps })
  if (!root) return { ok: false, error: 'setup needs --root <your brain_dump_map folder>' }
  if (!step('node version', nodeOk(), `${process.versions.node} (need ${KIT.node.min22}+ on 22, ${KIT.node.min24}+ on 24)`)) return done()
  if (!step('git available', git(['--version']).ok)) return done()

  let org = organizerState()
  if (!org.present) {
    const clone = git(['clone', '--quiet', KIT.organizer.repo, org.dir])
    if (!step('organizer cloned', clone.ok, clone.err)) return done()
  }
  git(['fetch', '--quiet', '--tags', 'origin'], org.dir)
  org = organizerState()
  if (org.dirty) { step('organizer has no local changes', false, `${org.dir} has edits; leaving it alone`); return done() }
  if (!org.atPin) {
    const co = git(['checkout', '--quiet', KIT.organizer.ref], org.dir)
    if (!step(`organizer at ${KIT.organizer.ref}`, co.ok, co.err)) return done()
  } else step(`organizer at ${KIT.organizer.ref}`, true)

  fs.mkdirSync(root, { recursive: true })
  let atelier = atelierState(root)
  if (!atelier.present || !atelier.atPin || !atelier.runs) {
    const install = npm(['install', '--prefix', path.join(root, '.external', 'atelier'), '--no-audit', '--no-fund', `${KIT.atelier.package}@${KIT.atelier.version}`])
    atelier = atelierState(root)
    if (!step(`atelier ${KIT.atelier.version} installed and runs`, atelier.atPin && atelier.runs, install.ok ? '' : install.err.slice(-400))) return done()
  } else step(`atelier ${KIT.atelier.version} installed and runs`, true)

  const init = organizer(root, 'init', '--viewer')
  if (!step('brain created with map settings', init.ok && init.json?.ok !== false, init.ok ? '' : init.err.slice(-400))) return done()
  const status = organizer(root, 'status')
  step('organizer status ok', status.ok && status.json?.ok === true, status.ok ? '' : status.err.slice(-400))
  return done()
}

export function selfUpdate() {
  if (!fs.existsSync(path.join(KIT_DIR, '.git'))) return { ok: true, skipped: 'not a git checkout' }
  const pull = git(['pull', '--quiet', '--ff-only'], KIT_DIR)
  return { ok: pull.ok, ...(pull.ok ? {} : { error: pull.err }) }
}
