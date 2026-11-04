// The nightly routine. Deterministic and model-free: import new exports, rebuild
// the index and the Atelier graph, check health, and save a local checkpoint.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { atelier } from './atelier.mjs'
import { importExports } from './import-chats.mjs'
import { isHub, scanCatalog, writeHubs, writeIndex } from './catalog.mjs'
import { INBOX, INDEX, STATE, UserError, localTime, writeAtomic, writeJson } from './notes.mjs'

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function inboxItems(root) {
  const dir = path.join(root, INBOX)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && (e.isDirectory() || /\.(zip|json)$/i.test(e.name)))
    .map(e => path.join(dir, e.name))
}

const TRACKED = ['notes', 'kit', '.brain', 'knowledge-plan.json', 'knowledge-plan.schema.json', 'atelier.project.json', 'atelier.lock.json', 'repo-access.v1.json', '.gitattributes', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'package-lock.json', 'my-map.json']

export function graphSummary(text) {
  const m = text.match(/knowledge graph: ([^\n]+)/)
  return m ? m[1].trim() : text.trim().split('\n').at(-1) ?? ''
}

export function refresh(root, { log = () => {}, commit = true } = {}) {
  const started = Date.now()
  const report = { at: new Date().toISOString(), imports: [], problems: [] }

  for (const item of inboxItems(root)) {
    try {
      const r = importExports(root, item, { log: line => { if (!line.startsWith('already imported')) log(line) } })
      report.imports.push({ item: path.basename(item), ...r })
    } catch (e) {
      if (!(e instanceof UserError)) throw e
      report.problems.push(`${path.basename(item)}: ${e.message}`)
    }
  }

  const seen = report.imports.reduce((n, i) => n + i.skippedFiles, 0)
  if (report.imports.length && report.imports.every(i => i.files === 0)) log(`inbox: nothing new (${seen} export file${seen === 1 ? '' : 's'} already imported)`)

  const catalog = scanCatalog(root)
  const notes = catalog.entries.filter(e => !isHub(e))
  const hubs = writeHubs(root, notes)
  catalog.entries = [...notes, ...hubs].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path))
  report.hubs = hubs.length
  report.index = writeIndex(root, catalog)
  log(`index: ${report.index.notes} notes, ${report.index.pending} waiting for a summary`)

  const g = atelier(root, ['graph'])
  report.graph = g.ok ? graphSummary(g.stdout + g.stderr) : null
  if (!g.ok) report.problems.push(`Atelier graph did not build: ${(g.stderr || g.stdout).trim().split('\n').slice(-2).join(' ')}`)
  else log(`atelier graph: ${report.graph}`)

  const k = atelier(root, ['knowledge', 'check'])
  if (k.ok) {
    try {
      const out = JSON.parse(k.stdout)
      report.knowledge = { status: out.status ?? null, coverage: out.coverage ?? null }
    } catch { report.knowledge = { status: 'ok' } }
  } else {
    report.problems.push(`Atelier knowledge check reported a problem: ${(k.stderr || k.stdout).trim().split('\n').slice(-2).join(' ')}`)
  }

  if (commit && fs.existsSync(path.join(root, '.git'))) {
    git(root, ['add', '--', ...TRACKED.filter(f => fs.existsSync(path.join(root, f)))])
    const staged = git(root, ['diff', '--cached', '--quiet'])
    if (!staged.ok) {
      const c = git(root, ['commit', '-q', '-m', `Refresh ${localTime(report.at)}`])
      report.checkpoint = c.ok ? git(root, ['rev-parse', '--short', 'HEAD']).out : null
      if (!c.ok) report.problems.push(`Could not save a checkpoint: ${c.err.split('\n').at(-1)}`)
    } else report.checkpoint = 'no changes'
  }

  report.seconds = Math.round((Date.now() - started) / 100) / 10
  writeJson(path.join(root, STATE, 'work', 'last-refresh.json'), report)
  const lines = [
    '# Last refresh',
    '',
    `${localTime(report.at)}, ${report.seconds}s`,
    '',
    `- Notes: ${report.index.notes} (${report.index.pending} waiting for a summary)`,
    ...report.imports.map(i => `- Imported ${i.item}: ${i.created} new, ${i.updated} updated${i.skippedFiles ? `, ${i.skippedFiles} file(s) already imported` : ''}`),
    `- Atelier graph: ${report.graph ?? 'not built'}`,
    `- Checkpoint: ${report.checkpoint ?? 'none'}`,
    ...(report.problems.length ? ['', '## Problems', '', ...report.problems.map(p => `- ${p}`)] : []),
    '',
  ]
  writeAtomic(path.join(root, INDEX, 'LAST-REFRESH.md'), lines.join('\n'))
  return report
}
