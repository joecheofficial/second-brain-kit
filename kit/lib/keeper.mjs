// Small fixed jobs for the nightly keeper. The keeper never writes the files that later sessions
// read, and never touches a shell: it calls these, and they write from fixed templates and
// checked numbers. No words from an email can travel through here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { STATE, UserError, localTime } from './notes.mjs'
import { addItems } from './add.mjs'
import { ownProjects } from './wiring.mjs'

const FLAGS = {
  login: source => `- ${source} needs you to sign in again before it can update.`,
  decision: source => `- ${source} needs a decision from you.`,
  'lock-off': () => '- The nightly safety lock was off, so the keeper stopped. Run: node kit/brain.mjs wire',
  'new-kit': () => '- A new Second Brain Kit is ready. To take it, run: node kit/brain.mjs tools-update --apply',
  'update-failed': () => '- The Second Brain Kit update did not finish. Run: node kit/brain.mjs doctor',
}
const SOURCES = new Set(['gmail', 'email', 'drive', 'dropbox', 'calendar', 'canva', 'notion', 'slack', 'other'])

export function flag(root, code, source = 'other') {
  if (!Object.hasOwn(FLAGS, code ?? '') || !SOURCES.has(source)) throw new UserError(`Use one of: ${Object.keys(FLAGS).join(', ')}`)
  const line = FLAGS[code](source === 'other' ? 'A source' : source)
  const file = path.join(root, '_review', 'NEEDS_ME.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (!old.split('\n').includes(line)) fs.writeFileSync(file, `${old.replace(/\n*$/, old ? '\n' : '')}${line}\n`)
  return line
}

function hubs(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'index', 'hubs.json'), 'utf8')) } catch { return [] }
}

export function logRun(root, { added = 0, summarised = 0, code = 'ok' }) {
  const all = hubs(root)
  const people = all.filter(h => h.kind === 'people').length
  const line = `${localTime()} added ${Number(added) || 0}, summarised ${Number(summarised) || 0}, ${people} people, ${all.length - people} projects, ${['ok', 'partial', 'stopped'].includes(code) ? code : 'ok'}\n`
  fs.appendFileSync(path.join(root, STATE, 'keeper.log'), line)
  return line.trim()
}

const AUTO = ['<!-- kit:auto:start -->', '<!-- kit:auto:end -->']

function writeAuto(file, lines) {
  const block = [AUTO[0], ...lines, AUTO[1]].join('\n')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const a = old.indexOf(AUTO[0])
  const b = old.indexOf(AUTO[1])
  fs.writeFileSync(file, a >= 0 && b > a ? old.slice(0, a) + block + old.slice(b + AUTO[1].length) : `${old.replace(/\n*$/, old ? '\n\n' : '')}${block}\n`)
}

export function frontDoor(root) {
  const all = hubs(root)
  const list = kind => (kind === 'projects' ? ownProjects(root, all) : all.filter(h => h.kind === kind)).sort((x, y) => y.links.length - x.links.length || y.notes - x.notes).slice(0, 25)
  const row = h => `- ${h.name} (${h.notes} notes${h.newest ? `, latest ${h.newest}` : ''})${h.links.length ? `: connected to ${h.links.slice(0, 4).map(l => l.name).join(', ')}` : ''}`
  writeAuto(path.join(root, 'PROJECTS.md'), ['## Most connected projects, updated nightly', '', ...list('projects').map(row)])
  writeAuto(path.join(root, 'SECOND_BRAIN.md'), [`## Updated ${localTime()}`, '', '### People', ...list('people').map(row), '', '### Projects', ...list('projects').map(row)])
  return { projects: list('projects').length, people: list('people').length }
}

const SKIP = new Set(['Library', 'AppData', 'node_modules', 'Applications', 'Pictures', 'Music', 'Movies'])
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'log.showSignature=false']

function gitDirs(dir, depth, out, skip) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  if (entries.some(e => e.name === '.git')) { out.push(dir); return }
  if (depth === 0) return
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && !skip.includes(full)) gitDirs(full, depth - 1, out, skip)
  }
}

const git = (dir, ...args) => {
  const r = spawnSync('git', [...SAFE_GIT, '-C', dir, ...args], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : ''
}

function readme(dir) {
  for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
    try {
      const file = path.join(dir, name)
      const stat = fs.lstatSync(file)
      // A cloned repo can make README a link to a key file, so only a real file counts.
      if (stat.isFile() && stat.size < 500_000) return fs.readFileSync(file, 'utf8').split('\n').slice(0, 40).join('\n')
    } catch {}
  }
  return ''
}

// Looks at the owner's code projects without changing them: names, last commit, README start.
export function scanRepos(root) {
  const home = os.homedir()
  const dirs = []
  gitDirs(home, 4, dirs, [root, path.join(home, 'second-brain-kit')])
  const items = dirs.map(dir => {
    const last = git(dir, 'log', '-1', '--format=%cs %s')
    return { source: 'other', id: dir, title: path.basename(dir), date: last.slice(0, 10) || undefined, body: [`Code project at ${dir}`, last && `Last commit: ${last}`, readme(dir)].filter(Boolean).join('\n\n') }
  })
  const gh = spawnSync('gh', ['repo', 'list', '--limit', '200', '--json', 'name,description,url,updatedAt,isPrivate,primaryLanguage'], { encoding: 'utf8', timeout: 20_000 })
  if (gh.status === 0) {
    for (const r of JSON.parse(gh.stdout || '[]')) items.push({ source: 'other', id: r.url, title: r.name, date: r.updatedAt, url: r.url, body: [`GitHub repo ${r.name}`, r.description, r.primaryLanguage?.name, r.isPrivate ? 'Private' : 'Public'].filter(Boolean).join('\n') })
  }
  return { found: items.length, ...addItems(root, items, { connector: true }) }
}

const pinned = kit => /ATELIER_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(kit, 'kit', 'lib', 'atelier.mjs'), 'utf8'))?.[1]

// The nightly run only looks, on Mondays. New code runs on this computer only when the owner
// says so with --apply, so a bad commit to the public repo cannot reach a sleeping machine.
export function toolsUpdate(root, { host, apply = false, now = new Date() } = {}) {
  if (!apply && now.getDay() !== 1) return { skipped: 'runs on Mondays' }
  const kit = path.join(os.homedir(), 'second-brain-kit')
  if (!fs.existsSync(path.join(kit, '.git'))) return { skipped: 'no kit folder' }
  if (!apply) {
    const fetched = spawnSync('git', [...SAFE_GIT, '-C', kit, 'fetch', '--quiet'], { encoding: 'utf8', timeout: 60_000 })
    if (fetched.status !== 0) return { skipped: 'could not reach the kit' }
    return git(kit, 'rev-list', '--count', 'HEAD..@{u}') > 0 ? { waiting: flag(root, 'new-kit') } : { current: true }
  }
  const pull = spawnSync('git', [...SAFE_GIT, '-C', kit, 'pull', '--ff-only'], { encoding: 'utf8', timeout: 60_000 })
  if (pull.status !== 0) return { failed: flag(root, 'update-failed') }
  const run = (file, ...args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 300_000 }).status === 0
  const ok = run(path.join(kit, 'kit', 'brain.mjs'), 'setup', '--target', root) && run(path.join(root, 'kit', 'brain.mjs'), 'wire', '--brain', root, ...(host ? ['--host', host] : []))
  return ok ? { updated: true } : { failed: flag(root, 'update-failed') }
}
