// Create (or repair) a second brain. Safe to run again: it never deletes notes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ATELIER_VERSION, NODE_RANGE, atelier, installedVersion, nodeSupported } from './atelier.mjs'
import { INBOX, NOTES, STATE, UserError, readJson, writeAtomic, writeJson } from './notes.mjs'
import { compareVersions, npm, parseVersion } from './update.mjs'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KIT_VERSION = readJson(path.join(KIT, 'VERSION.json'), { version: 'dev' }).version

// The invented starter files that `atelier init` adds and this brain replaces.
const STARTER_RECORDS = ['records/inspection.md', 'records/telescope.md', 'records/forecast.md']
const OWNED = ['atelier.project.json', 'repo-access.v1.json', 'AGENTS.md', 'CLAUDE.md', 'README.md']

function run(cmd, args, cwd, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'] })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export function defaultTarget() {
  return path.join(os.homedir(), 'second-brain')
}

function syncedFolderWarning(target) {
  const t = target.toLowerCase()
  if (/dropbox|onedrive|google drive|googledrive|mobile documents|icloud/.test(t)) {
    return 'This folder is inside a cloud-synced folder. Syncing a Git folder can corrupt it. A plain folder such as ~/second-brain is safer.'
  }
  return null
}

function insideOtherRepo(target) {
  let dir = path.dirname(target)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.DS_Store') continue
    const a = path.join(from, e.name)
    const b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

export function setup({ target = defaultTarget(), log = console.log, install = true } = {}) {
  target = path.resolve(target.replace(/^~(?=$|\/|\\)/, os.homedir()))
  if (!nodeSupported()) {
    throw new UserError(`This needs Node.js 24 (or 22.18+). You have ${process.version}. Install Node 24 LTS from https://nodejs.org, open a new terminal, and run setup again.`)
  }
  if (!run('git', ['--version'], process.cwd(), { quiet: true }).ok) {
    throw new UserError('Git is not installed. On a Mac run `xcode-select --install`; on Windows install Git from https://git-scm.com. Then run setup again.')
  }
  const other = insideOtherRepo(target)
  if (other && path.resolve(other) !== target) {
    throw new UserError(`${target} is inside another Git project (${other}). Choose a folder outside it, such as ~/second-brain.`)
  }
  const warn = syncedFolderWarning(target)
  if (warn) log(`Note: ${warn}`)

  const fresh = !fs.existsSync(path.join(target, STATE, 'brain.json'))
  fs.mkdirSync(target, { recursive: true })
  const ws = path.join(KIT, 'workspace')

  // The kit travels with the brain so the nightly refresh never depends on Downloads.
  if (path.resolve(KIT) !== path.join(target, 'kit')) {
    fs.rmSync(path.join(target, 'kit'), { recursive: true, force: true })
    copyDir(KIT, path.join(target, 'kit'))
    log('Copied the kit into the brain.')
  }
  // Prompts in the brain's copy name this brain's real folder.
  const prompts = path.join(target, 'kit', 'prompts')
  for (const name of fs.existsSync(prompts) ? fs.readdirSync(prompts) : []) {
    if (!name.endsWith('.md')) continue
    const file = path.join(prompts, name)
    const text = fs.readFileSync(path.join(KIT, 'prompts', name), 'utf8')
    fs.writeFileSync(file, text.replace(/\bBRAIN\b/g, target.split(path.sep).join('/')).replace(/\bNIGHTLY_BATCHES\b/g, '15'))
  }

  const pkgFile = path.join(target, 'package.json')
  if (!fs.existsSync(pkgFile)) fs.copyFileSync(path.join(ws, 'package.json'), pkgFile)
  else {
    // Never downgrade: a brain updated to a newer Atelier keeps it.
    const pkg = readJson(pkgFile, {})
    const pinned = pkg.devDependencies?.['@mnstry/atelier']
    if (!parseVersion(pinned) || compareVersions(pinned, ATELIER_VERSION) < 0) {
      pkg.devDependencies = { ...(pkg.devDependencies ?? {}), '@mnstry/atelier': ATELIER_VERSION }
      writeJson(pkgFile, pkg)
    }
  }
  const wanted = readJson(pkgFile, {}).devDependencies['@mnstry/atelier']

  if (install && installedVersion(target) !== wanted) {
    log(`Installing Atelier ${wanted} (about a minute)…`)
    const r = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], target)
    if (!r.ok || installedVersion(target) !== wanted) {
      if (r.err.trim()) log(r.err.trim().split('\n').slice(-6).join('\n'))
      throw new UserError('npm install did not finish. Check the internet connection and run setup again. If it keeps failing, copy the error above to your facilitator.')
    }
  }

  if (!fs.existsSync(path.join(target, 'atelier.lock.json'))) {
    const r = atelier(target, ['init', '--template', 'knowledge-workspace', '--target', '.'])
    if (!r.ok) throw new UserError(`Atelier could not set up the folder: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
    // Remove only the invented example records the template ships.
    for (const f of STARTER_RECORDS) fs.rmSync(path.join(target, f), { force: true })
    try { fs.rmdirSync(path.join(target, 'records')) } catch {}
    fs.rmSync(path.join(target, '.claude', 'launch.json'), { force: true })
    try { fs.rmdirSync(path.join(target, '.claude')) } catch {}
    fs.copyFileSync(path.join(ws, 'knowledge-plan.json'), path.join(target, 'knowledge-plan.json'))
  }
  for (const f of OWNED) fs.copyFileSync(path.join(ws, f), path.join(target, f))

  // .gitignore: add our lines, keep anything the person added.
  const gi = path.join(target, '.gitignore')
  const have = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''
  const want = fs.readFileSync(path.join(ws, 'gitignore'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
  const missing = want.filter(l => !have.split(/\r?\n/).includes(l))
  if (missing.length) writeAtomic(gi, `${have.replace(/\n*$/, '\n')}${missing.join('\n')}\n`)

  for (const d of [NOTES, `${NOTES}/my-notes`, INBOX, STATE, `${STATE}/work`]) fs.mkdirSync(path.join(target, d), { recursive: true })
  const keep = path.join(target, NOTES, 'my-notes', '.gitkeep')
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '')

  if (!fs.existsSync(path.join(target, '.git'))) run('git', ['init', '-q'], target)
  // Local-only history: refuse every push, so a mistaken remote cannot leak the brain.
  const hook = path.join(target, '.git', 'hooks', 'pre-push')
  fs.mkdirSync(path.dirname(hook), { recursive: true })
  fs.writeFileSync(hook, '#!/bin/sh\necho "This is a private second brain. Pushing is switched off." >&2\nexit 1\n', { mode: 0o755 })
  const name = run('git', ['config', 'user.name'], target, { quiet: true })
  if (!name.out.trim()) run('git', ['config', 'user.name', 'Second brain'], target, { quiet: true })
  const email = run('git', ['config', 'user.email'], target, { quiet: true })
  if (!email.out.trim()) run('git', ['config', 'user.email', 'brain@localhost'], target, { quiet: true })

  writeJson(path.join(target, STATE, 'brain.json'), {
    kit: KIT_VERSION,
    atelier: wanted,
    node: NODE_RANGE,
    created: readJson(path.join(target, STATE, 'brain.json'), {}).created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  })
  return { target, fresh }
}
