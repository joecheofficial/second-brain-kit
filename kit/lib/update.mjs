// Keep Atelier up to date, safely. Three separate steps, so the owner decides:
//   check   – ask npm which tagged releases exist (no changes)
//   prepare – install the candidate on the side and test it on this brain
//   apply   – switch to the tested candidate; any failure puts the old one back
// Only versions MNSTRY tagged on npm (`latest` or `alpha`) are offered, never older.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ATELIER_VERSION, atelier, atelierEntry, installedVersion } from './atelier.mjs'
import { STATE, UserError, readJson, writeJson } from './notes.mjs'

const PACKAGE = '@mnstry/atelier'
const TAGS = ['latest', 'alpha']
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATE_HOURS = 24

const work = root => path.join(root, STATE, 'work')

export function npm(args, cwd) {
  // Tests substitute a stand-in for npm; nothing else does.
  const [cmd, pre] = process.env.BRAIN_NPM ? [process.execPath, [process.env.BRAIN_NPM]] : ['npm', []]
  const r = spawnSync(cmd, [...pre, ...args], { cwd, encoding: 'utf8', shell: !process.env.BRAIN_NPM && process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? r.error.message : '') }
}

export function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export function kitTested() {
  return readJson(path.join(KIT, 'VERSION.json'), {}).atelierTested ?? [ATELIER_VERSION]
}

export function checkForUpdate(root) {
  const current = installedVersion(root)
  const r = npm(['view', PACKAGE, 'dist-tags', '--json'], root)
  if (!r.ok) throw new UserError('I could not reach npm to check for updates. Check the internet connection and try again later.')
  let tags
  try { tags = JSON.parse(r.out) } catch { throw new UserError('npm gave an answer I could not read. Try again later.') }
  const tagged = TAGS.filter(t => parseVersion(tags[t])).map(t => ({ tag: t, version: tags[t] }))
  const newer = tagged.filter(t => current && compareVersions(t.version, current) > 0)
  newer.sort((a, b) => compareVersions(b.version, a.version))
  const newest = newer[0]?.version ?? null
  const result = { checkedAt: new Date().toISOString(), current, tags: tagged, newest, testedWithThisKit: newest ? kitTested().includes(newest) : null }
  writeJson(path.join(work(root), 'update-check.json'), result)
  return result
}

// The release's own upgrade notes, from the candidate package.
function upgradeNotes(pkgRoot, from, to) {
  const file = path.join(pkgRoot, 'docs', 'guides', 'upgrade.md')
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const sections = text.split(/^## /m).slice(1).map(s => ({ title: s.split('\n')[0].trim(), body: s.slice(s.indexOf('\n') + 1).trim() }))
  const wanted = sections.filter(s => {
    const v = s.title.match(/Upgrading to (\S+)/)?.[1]
    return v && parseVersion(v) && compareVersions(v, from) > 0 && compareVersions(v, to) <= 0
  })
  return wanted.map(s => `## ${s.title}\n\n${s.body}`).join('\n\n') || null
}

function announcementIds(root, entry) {
  const r = spawnSync(process.execPath, [entry, 'announcements', 'list'], { cwd: root, encoding: 'utf8' })
  return new Map((r.stdout ?? '').split('\n').filter(l => l.startsWith('announcement:')).map(l => [l.split(/\s+/)[0], l.trim()]))
}

function recentQuestion(root) {
  const catalog = path.join(root, 'index', 'notes.jsonl')
  const first = fs.existsSync(catalog) ? fs.readFileSync(catalog, 'utf8').split('\n').find(Boolean) : null
  return first ? JSON.parse(first).title : 'What am I working on?'
}

// Install a release beside the working one and test it against this brain.
export function prepareUpdate(root, { to } = {}) {
  const current = installedVersion(root)
  if (!current) throw new UserError('Atelier is not installed here yet. Run setup first.')
  let target = to
  if (!target) {
    const check = checkForUpdate(root)
    if (!check.newest) return { status: 'up-to-date', current }
    target = check.newest
  }
  if (!parseVersion(target)) throw new UserError(`"${target}" is not a version number.`)
  if (compareVersions(target, current) <= 0) return { status: 'up-to-date', current }

  const dir = path.join(work(root), `candidate-${target}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  writeJson(path.join(dir, 'package.json'), { name: 'atelier-candidate', private: true, devDependencies: { [PACKAGE]: target } })
  const install = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], dir)
  if (!install.ok || installedVersion(dir) !== target) {
    throw new UserError(`Could not download Atelier ${target}. Nothing was changed. ${install.err.trim().split('\n').slice(-2).join(' ')}`)
  }
  const lock = readJson(path.join(dir, 'package-lock.json'), {})
  const integrity = lock.packages?.[`node_modules/${PACKAGE}`]?.integrity ?? null

  // Run the candidate on this brain: read-only checks, then a graph build that
  // the working version rebuilds straight afterwards.
  const entry = atelierEntry(dir)
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  const checks = []
  const record = (name, r, ok = r.status === 0) => checks.push({ name, ok, detail: ok ? null : (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ') })
  record('knowledge check', run(['knowledge', 'check']))
  record('knowledge evaluate', run(['knowledge', 'evaluate']))
  const ctx = run(['knowledge', 'context', '--question', recentQuestion(root)])
  let ctxOk = false
  try { ctxOk = ctx.status === 0 && JSON.parse(ctx.stdout).schema === 'atelier-knowledge-context@v1' } catch {}
  record('knowledge context', ctx, ctxOk)
  const before = readJson(path.join(root, 'atelier-output', 'knowledge.graph.json'), null)
  const g = run(['graph'])
  const after = readJson(path.join(root, 'atelier-output', 'knowledge.graph.json'), null)
  const sameShape = g.status === 0 && after?.schema === 'mnstry.atelier-knowledge-graph@v1' && (!before || after.nodes?.length === before.nodes?.length)
  record('graph (same notes, same format)', g, sameShape)
  atelier(root, ['graph'])

  const passed = checks.every(c => c.ok)
  const result = {
    status: passed ? 'ready' : 'failed-checks',
    current, target, integrity,
    testedWithThisKit: kitTested().includes(target),
    checks,
    notes: upgradeNotes(path.join(dir, 'node_modules', '@mnstry', 'atelier'), current, target),
    preparedAt: new Date().toISOString(),
  }
  writeJson(path.join(work(root), 'update-candidate.json'), result)
  if (!passed) fs.rmSync(dir, { recursive: true, force: true })
  return result
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

// Switch to the prepared release. On any failure, put the previous one back.
export function applyUpdate(root, { log = () => {}, refreshFn } = {}) {
  const cand = readJson(path.join(work(root), 'update-candidate.json'), null)
  if (!cand || cand.status !== 'ready') throw new UserError('There is no tested update waiting. Run `node kit/brain.mjs update` first.')
  if (Date.now() - Date.parse(cand.preparedAt) > CANDIDATE_HOURS * 3_600_000) throw new UserError('The tested update is more than a day old. Run `node kit/brain.mjs update` again to re-test it.')
  const current = installedVersion(root)
  if (current !== cand.current) throw new UserError('Atelier changed since the update was tested. Run `node kit/brain.mjs update` again.')

  const backup = path.join(work(root), `rollback-${cand.current}`)
  fs.rmSync(backup, { recursive: true, force: true })
  fs.mkdirSync(backup, { recursive: true })
  const saved = ['package.json', 'package-lock.json', 'atelier.lock.json'].filter(f => fs.existsSync(path.join(root, f)))
  for (const f of saved) fs.copyFileSync(path.join(root, f), path.join(backup, f))
  const oldAnnouncements = announcementIds(root, atelierEntry(root))

  const restore = why => {
    for (const f of saved) fs.copyFileSync(path.join(backup, f), path.join(root, f))
    const back = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], root)
    const ok = back.ok && installedVersion(root) === cand.current
    atelier(root, ['graph'])
    throw new UserError(`The update to ${cand.target} did not complete (${why}). ${ok ? `Atelier ${cand.current} is back in place and nothing else changed.` : `Putting ${cand.current} back also failed: run \`npm install\` in the brain folder, then \`node kit/brain.mjs doctor\`.`}`)
  }

  const pkg = readJson(path.join(root, 'package.json'), {})
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [PACKAGE]: cand.target }
  writeJson(path.join(root, 'package.json'), pkg)
  log(`Installing Atelier ${cand.target}…`)
  const inst = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], root)
  if (!inst.ok || installedVersion(root) !== cand.target) restore('download or install failed')
  const integrity = readJson(path.join(root, 'package-lock.json'), {}).packages?.[`node_modules/${PACKAGE}`]?.integrity ?? null
  if (cand.integrity && integrity && integrity !== cand.integrity) restore('the installed package differs from the one that was tested')
  const lw = atelier(root, ['lock', 'write'])
  if (!lw.ok) restore('Atelier could not record its new version')
  const lc = atelier(root, ['lock', 'check'])
  if (!lc.ok) restore('the Atelier lock check failed')
  const rep = refreshFn ? refreshFn(root) : null
  if (rep && rep.problems?.some(p => /Atelier/.test(p))) restore(rep.problems.find(p => /Atelier/.test(p)))

  git(root, ['add', '--', ...saved])
  git(root, ['commit', '-q', '-m', `Update Atelier ${cand.current} to ${cand.target}`])
  fs.rmSync(path.join(work(root), `candidate-${cand.target}`), { recursive: true, force: true })
  fs.rmSync(path.join(work(root), 'update-candidate.json'), { force: true })
  writeJson(path.join(work(root), 'update-check.json'), { checkedAt: new Date().toISOString(), current: cand.target, newest: null, tags: [] })
  const fresh = [...announcementIds(root, atelierEntry(root)).entries()].filter(([id]) => !oldAnnouncements.has(id)).map(([, line]) => line)
  return { from: cand.current, to: cand.target, testedWithThisKit: cand.testedWithThisKit, announcements: fresh }
}

export function formatPrepared(r) {
  if (r.status === 'up-to-date') return `Atelier ${r.current} is the newest release. Nothing to do.`
  const lines = [`Atelier ${r.current} → ${r.target}`, '']
  for (const c of r.checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`)
  lines.push('')
  if (r.status !== 'ready') {
    lines.push(`The new release did not pass on your brain, so nothing was changed. Keep using ${r.current}; your facilitator may send a kit update.`)
    return lines.join('\n')
  }
  if (!r.testedWithThisKit) lines.push(`Note: this kit was tested with ${kitTested().join(', ')}. The checks above passed on your brain; if anything looks off afterwards, ask your facilitator for a newer kit.`, '')
  if (r.notes) lines.push('What the release says about upgrading:', '', r.notes, '')
  lines.push('Your working version has not changed. To switch, run:', '  node kit/brain.mjs update --apply', 'If anything fails it puts the current version back.')
  return lines.join('\n')
}
