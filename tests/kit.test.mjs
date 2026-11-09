// Kit tests. Invented data only.
//   ATELIER_MODULES=<node_modules containing the pinned @mnstry/atelier> node --test dev/test/
// Without ATELIER_MODULES the setup/refresh tests that need Atelier are skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ATELIER_VERSION } from '../kit/lib/atelier.mjs'
import { chatgptExport, claudeExport, claudeProjects, writeExports } from './fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const KIT = path.resolve(here, '../kit')
const lib = name => import(path.join(KIT, 'lib', name))
const modules = process.env.ATELIER_MODULES ? path.resolve(process.env.ATELIER_MODULES) : null

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `brain-${name}-`))
}

// A bare brain for the pure tools: no Atelier needed.
function bareBrain() {
  const root = tmp('bare')
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true })
  fs.writeFileSync(path.join(root, '.brain', 'brain.json'), '{}')
  fs.copyFileSync(path.join(KIT, 'workspace', 'knowledge-plan.json'), path.join(root, 'knowledge-plan.json'))
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  return root
}

const allNotes = async root => {
  const { walkNotes, rel } = await lib('notes.mjs')
  return [...walkNotes(root)].map(f => rel(root, f)).sort()
}

test('front matter round-trips, including line separators and nested relations', async () => {
  const { writeFrontmatter, readNote } = await lib('frontmatter.mjs')
  const data = { title: 'A "quoted" title: with colon', tags: ['source:x', 'concept:idea'], kg: { id: 'a:b', relations: { related: ['x:1', 'x:2'] } }, n: 3, flag: true }
  const text = writeFrontmatter(data, '# Body\n\n---\n\nmore')
  assert.ok(!text.includes(' '), 'raw line separator escaped')
  const back = readNote(text)
  assert.deepEqual(back.data, data)
  assert.equal(back.body, '# Body\n\n---\n\nmore')
})

test('ChatGPT export: current branch only, hidden and tool messages dropped, empty skipped', async () => {
  const { notesFromExport, detectKind } = await lib('import-chats.mjs')
  const data = chatgptExport(20)
  assert.equal(detectKind(data, 'conversations.json'), 'chatgpt')
  const notes = notesFromExport('chatgpt', data)
  assert.equal(notes.length, 20, 'the empty conversation is skipped')
  const n = notes[1]
  assert.match(n.body, /### You/)
  assert.match(n.body, /\[image\]/)
  assert.doesNotMatch(n.body, /regenerated/, 'abandoned branch excluded')
  assert.doesNotMatch(n.body, /ignored/, 'tool output excluded')
  assert.equal(n.extra.messages, 4)
  assert.ok(n.title.length > 0)
  assert.ok(notes[5].title.length > 0, 'untitled conversation gets a title from its first message')
  assert.match(n.url, /^https:\/\/chatgpt\.com\/c\//)
})

test('Claude export and projects: thinking dropped, attachments kept, projects become notes', async () => {
  const { notesFromExport, detectKind } = await lib('import-chats.mjs')
  const data = claudeExport(6)
  assert.equal(detectKind(data, 'conversations.json'), 'claude')
  const notes = notesFromExport('claude', data)
  assert.equal(notes.length, 6)
  assert.doesNotMatch(notes[0].body, /hidden/)
  assert.match(notes[0].body, /Attached: notes\.txt/)
  assert.equal(detectKind(claudeProjects(), 'projects.json'), 'claude-projects')
  const projects = notesFromExport('claude-projects', claudeProjects())
  assert.equal(projects.length, 2)
  assert.match(projects[1].body, /Rye sourdough/)
})

test('importing twice changes nothing; enrichment survives; a changed chat is queued again', async () => {
  const root = bareBrain()
  const { importExports } = await lib('import-chats.mjs')
  const { applyEnrichment, nextBatch } = await lib('queue.mjs')
  const dir = tmp('exports')
  const { gpt } = writeExports(dir, { chatgpt: 8, claude: 3 })
  const first = importExports(root, dir)
  assert.equal(first.created, 8 + 3 + 2)
  const again = importExports(root, dir)
  assert.equal(again.skippedFiles, 3, 'already-imported files are recognised by content')
  const batch = nextBatch(root, { worker: 'h1', batch: 2 })
  const target = batch.find(b => b.source === 'chatgpt') ?? batch[0]
  const r = applyEnrichment(root, [{ path: target.path, summary: 'Planned the newsletter and chose the seasonal loaf lead.', topics: ['Newsletter Plan'], people: ['Imani Brook'], concepts: ['decision', 'not-a-concept'] }], { worker: 'h1' })
  assert.equal(r.applied, 1)
  const enriched = fs.readFileSync(path.join(root, target.path), 'utf8')
  assert.match(enriched, /"concept:decision"/)
  assert.doesNotMatch(enriched, /not-a-concept/)
  assert.match(enriched, /"newsletter-plan"/)
  const forced = importExports(root, dir, { force: true })
  assert.equal(forced.created, 0)
  assert.equal(forced.updated, 0, 'enriched note is unchanged by a re-import')
  assert.equal(fs.readFileSync(path.join(root, target.path), 'utf8'), enriched)
  // The same conversation, continued.
  const data = JSON.parse(fs.readFileSync(path.join(gpt, 'conversations.json'), 'utf8'))
  const id = enriched.match(/source_id: "([^"]+)"/)[1]
  const conv = data.find(c => c.conversation_id === id)
  if (conv) {
    conv.mapping.a2.children = ['u3']
    conv.mapping.u3 = { id: 'u3', parent: 'a2', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['One more thing about the flyer.'] }, create_time: conv.update_time + 10 } }
    conv.current_node = 'u3'
    fs.writeFileSync(path.join(gpt, 'conversations.json'), JSON.stringify(data))
    importExports(root, gpt)
    const updated = fs.readFileSync(path.join(root, target.path), 'utf8')
    assert.match(updated, /One more thing/)
    assert.match(updated, /enrichment: "pending"/, 'changed conversation is summarised again')
    assert.match(updated, /Planned the newsletter/, 'old summary kept until replaced')
  }
})

test('helpers never get the same note, and cannot write outside notes/', async () => {
  const root = bareBrain()
  const { importExports } = await lib('import-chats.mjs')
  const { nextBatch, applyEnrichment } = await lib('queue.mjs')
  const dir = tmp('exports')
  writeExports(dir, { chatgpt: 30, claude: 0 })
  importExports(root, dir)
  const a = nextBatch(root, { worker: 'h1', batch: 10 })
  const b = nextBatch(root, { worker: 'h2', batch: 10 })
  assert.equal(a.length, 10)
  assert.equal(b.length, 10)
  assert.equal(new Set([...a, ...b].map(x => x.path)).size, 20)
  assert.ok(a[0].excerpt.length > 0 && a[0].excerpt.length < 3500)
  assert.ok(a[0].date >= a.at(-1).date, 'newest first')
  fs.writeFileSync(path.join(root, 'outside.md'), 'x')
  const r = applyEnrichment(root, [
    { path: '../outside.md', summary: 'An attempt to write outside the notes folder.' },
    { path: 'outside.md', summary: 'An attempt to write outside the notes folder.' },
    { path: a[0].path, summary: 'short' },
  ])
  assert.equal(r.applied, 0)
  assert.equal(r.skipped.length, 3)
  assert.equal(fs.readFileSync(path.join(root, 'outside.md'), 'utf8'), 'x')
  assert.throws(() => nextBatch(root, { worker: '../evil' }), /short name/)
})

test('connector items: one note per id, validated, safe file names', async () => {
  const root = bareBrain()
  const { addItems, parseItems } = await lib('add.mjs')
  const items = parseItems(JSON.stringify([
    { source: 'gmail', id: 'thr-1', title: 'Re: venue / March?', date: '2025-02-10T09:00:00Z', people: ['Teo <teo@example.com>'], url: 'https://mail.example/thr-1', body: 'Deposit 150 confirmed.' },
    { source: 'drive', id: '../../etc', title: 'Budget', body: 'Venue 450.' },
    { source: 'chatgpt', id: 'x', title: 'not allowed here', body: 'x' },
    { source: 'gmail', title: 'no id', body: 'x' },
  ]))
  const r = addItems(root, items)
  assert.equal(r.created, 2)
  assert.equal(r.skipped.length, 2)
  const again = addItems(root, [items[0]])
  assert.equal(again.unchanged, 1)
  const files = await allNotes(root)
  assert.ok(files.every(f => f.startsWith('notes/email/gmail/') || f.startsWith('notes/documents/google-drive/')), files.join(', '))
  assert.ok(files.every(f => !f.includes('..')))
  assert.equal(parseItems('{"a":1}\n{"b":2}').length, 2)
})

test('find ranks the note with every word first and points at the matching line', async () => {
  const root = bareBrain()
  const { addItems } = await lib('add.mjs')
  addItems(root, [
    { source: 'gmail', id: 'a', title: 'Venue booking', date: '2025-02-10', body: 'Teo confirmed the co-working room. Deposit 150.' },
    { source: 'gmail', id: 'b', title: 'Lunch', date: '2025-02-11', body: 'Teo says hi.' },
    { source: 'note', id: 'c', title: 'Unrelated', body: 'Nothing to see.' },
  ])
  const { find, formatFind } = await lib('find.mjs')
  const out = find(root, 'What deposit did Teo confirm?')
  assert.deepEqual(out.words, ['deposit', 'teo', 'confirm'])
  assert.equal(out.results[0].title, 'Venue booking')
  assert.ok(out.results[0].match.text.includes('Deposit'))
  assert.ok(out.results[0].match.line > 5, 'snippet comes from the text, not the front matter')
  assert.equal(find(root, 'zebra').results.length, 0)
  assert.match(formatFind(find(root, 'zebra')), /does not prove/)
})

test('hubs and index: a hub per project named twice, removed when it no longer applies', async () => {
  const root = bareBrain()
  const { addItems } = await lib('add.mjs')
  const { applyEnrichment } = await lib('queue.mjs')
  const { scanCatalog, writeHubs, writeIndex } = await lib('catalog.mjs')
  addItems(root, [1, 2, 3].map(i => ({ source: 'note', id: `n${i}`, title: `Note ${i}`, date: `2025-01-0${i}`, body: `Body ${i}` })))
  const paths = (await allNotes(root))
  applyEnrichment(root, paths.slice(0, 2).map(p => ({ path: p, summary: 'About the spring workshop plans.', projects: ['Spring Workshop'] })))
  let hubs = writeHubs(root, scanCatalog(root).entries)
  assert.equal(hubs.length, 1)
  const hub = fs.readFileSync(path.join(root, hubs[0].path), 'utf8')
  assert.match(hub, /related:/)
  assert.equal((hub.match(/- "note:mine:/g) ?? []).length, 2)
  const stats = writeIndex(root, scanCatalog(root))
  assert.ok(fs.existsSync(path.join(root, 'index', 'INDEX.md')))
  assert.equal(stats.notes, 4)
  applyEnrichment(root, [{ path: paths[0], summary: 'No longer about the workshop at all.', projects: [] }])
  hubs = writeHubs(root, scanCatalog(root).entries.filter(e => !e.path.startsWith('notes/hubs/')))
  assert.equal(hubs.length, 0)
  assert.ok(!fs.existsSync(path.join(root, 'notes', 'hubs', 'projects', 'spring-workshop.md')))
})

test('setup, refresh, doctor and map with the published Atelier package', { skip: !modules && 'set ATELIER_MODULES' }, async () => {
  const home = tmp('home')
  const target = path.join(home, 'second-brain')
  fs.mkdirSync(target, { recursive: true })
  fs.symlinkSync(modules, path.join(target, 'node_modules'), 'dir')
  const run = (...args) => spawnSync(process.execPath, [path.join(KIT, 'brain.mjs'), ...args], { cwd: home, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  const s = run('setup', '--target', target)
  assert.equal(s.status, 0, s.stderr + s.stdout)
  for (const f of ['atelier.lock.json', 'knowledge-plan.json', 'AGENTS.md', 'CLAUDE.md', '.git/hooks/pre-push', 'kit/brain.mjs']) assert.ok(fs.existsSync(path.join(target, f)), f)
  assert.ok(!fs.existsSync(path.join(target, 'records')), 'invented starter records removed')
  const snippet = fs.readFileSync(path.join(target, 'kit', 'prompts', 'orchestrator-snippet.md'), 'utf8')
  assert.ok(snippet.includes(`${target}/kit/brain.mjs`) && !/\bBRAIN\b/.test(snippet), 'prompts name the real folder')
  writeExports(path.join(target, 'inbox'), { chatgpt: 12, claude: 4 })
  // The brain's own kit copy, run from outside the brain, finds its brain.
  const inner = (...args) => spawnSync(process.execPath, [path.join(target, 'kit', 'brain.mjs'), ...args], { cwd: home, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  const r = inner('refresh')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /18 notes/)
  assert.match(r.stdout, /atelier graph: 18 nodes/)
  const check = spawnSync(process.execPath, [path.join(target, 'node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs'), 'knowledge', 'evaluate'], { cwd: target, encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr + check.stdout)
  const ctx = spawnSync(process.execPath, [path.join(target, 'node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs'), 'knowledge', 'context', '--question', 'Which venue has the projector?'], { cwd: target, encoding: 'utf8' })
  assert.equal(JSON.parse(ctx.stdout).status, 'evidence-selected')
  const tracked = spawnSync('git', ['ls-files'], { cwd: target, encoding: 'utf8' }).stdout
  assert.ok(!/^inbox\//m.test(tracked) && !/^node_modules/m.test(tracked) && !/^index\//m.test(tracked), 'raw exports and generated files stay out of history')
  assert.match(tracked, /^notes\/chats\/chatgpt\//m)
  // A reachable remote (a local bare repository): the pre-push hook must refuse.
  const bare = path.join(home, 'remote.git')
  spawnSync('git', ['init', '-q', '--bare', bare])
  spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: target })
  const push = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: target, encoding: 'utf8' })
  assert.notEqual(push.status, 0)
  assert.match(push.stderr, /Pushing is switched off/)
  assert.equal(spawnSync('git', ['rev-list', '--all'], { cwd: bare, encoding: 'utf8' }).stdout, '', 'nothing reached the remote')
  // Saved items are searchable at once, before the next refresh.
  const item = path.join(home, 'item.json')
  fs.writeFileSync(item, JSON.stringify({ source: 'note', id: 'clay', title: 'Clay Saturdays kiln schedule', body: 'Kiln firing every second Saturday.' }))
  assert.equal(inner('add', '--file', item).status, 0)
  assert.match(inner('find', 'kiln firing').stdout, /Clay Saturdays kiln schedule/)
  assert.match(inner('refresh').stdout, /nothing new|Nothing changed|Checkpoint/)
  assert.doesNotMatch(inner('refresh').stdout, /^already imported: /m, 'one quiet summary line instead of one line per file')
  const d = inner('doctor')
  assert.match(d.stdout, /✗ No online copy configured/)
  spawnSync('git', ['remote', 'remove', 'origin'], { cwd: target })
  const d2 = inner('doctor')
  assert.equal(d2.status, 0, d2.stdout)
  const m = inner('map', '--no-open')
  assert.equal(m.status, 0, m.stderr)
  const data = fs.readFileSync(path.join(target, 'map', 'brain-data.js'), 'utf8')
  assert.ok(data.startsWith('window.BRAIN=') && !data.includes('</script'))
  assert.ok(fs.existsSync(path.join(target, 'map', 'depth.js')), 'the 3D view ships beside the map')
  const brainData = JSON.parse(data.slice('window.BRAIN='.length, -2))
  assert.ok(Object.keys(brainData.dates).length >= 16, 'note dates for the through-time view')
  assert.ok('distribution' in brainData && !('coach' in brainData), 'the middle layer is called distribution')
  const again = run('setup', '--target', target)
  assert.equal(again.status, 0, again.stderr)
  assert.equal((await allNotes(target)).length, 19, 'running setup again keeps every note')
})

test('versions compare the way npm orders them', async () => {
  const { compareVersions } = await lib('update.mjs')
  assert.ok(compareVersions('0.2.0-alpha.15', '0.2.0-alpha.12') > 0)
  assert.ok(compareVersions('0.2.0-alpha.10', '0.2.0-alpha.9') > 0)
  assert.ok(compareVersions('0.2.0', '0.2.0-alpha.15') > 0)
  assert.ok(compareVersions('0.3.0-alpha.1', '0.2.9') > 0)
  assert.equal(compareVersions('0.2.0-alpha.15', '0.2.0-alpha.15'), 0)
})

// Real pinned package plus explicitly synthetic versions for offline update tests.
const LEGACY_VERSION = '0.2.0-alpha.16'
const nextVersion = offset => ATELIER_VERSION.replace(/(\d+)$/, n => Number(n) + offset)
const FUTURE_VERSION = nextVersion(1)
const BROKEN_VERSION = nextVersion(2)
const versionPattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function fakeRegistry(base) {
  const real = path.join(modules, '@mnstry', 'atelier')
  const pkgs = path.join(base, 'pkgs')
  assert.equal(JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')).version, ATELIER_VERSION, 'integration package matches the kit pin')
  for (const v of new Set([LEGACY_VERSION, ATELIER_VERSION, FUTURE_VERSION, BROKEN_VERSION])) {
    const dir = path.join(pkgs, v)
    fs.cpSync(real, dir, { recursive: true })
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    pj.version = v
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj, null, 2))
    const guide = path.join(dir, 'docs', 'guides', 'upgrade.md')
    fs.writeFileSync(guide, `## Upgrading to ${v}\n\nInvented test note for ${v}.\n\n` + fs.readFileSync(guide, 'utf8'))
  }
  const bin = path.join(pkgs, BROKEN_VERSION, 'bin', 'atelier.mjs')
  fs.renameSync(bin, path.join(path.dirname(bin), 'atelier-real.mjs'))
  fs.writeFileSync(bin, `if (process.argv[2] === 'knowledge' && process.argv[3] === 'check') { console.error('invented failure'); process.exit(1) }\nawait import('./atelier-real.mjs')\n`)
  return pkgs
}

function legacyInstall(target, env) {
  const pkgFile = path.join(target, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  pkg.devDependencies['@mnstry/atelier'] = LEGACY_VERSION
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
  const install = spawnSync(process.execPath, [env.BRAIN_NPM, 'install'], { cwd: target, env, encoding: 'utf8' })
  assert.equal(install.status, 0, install.stderr)
  const lock = spawnSync(process.execPath, [path.join(target, 'node_modules', '@mnstry', 'atelier', 'bin', 'atelier.mjs'), 'lock', 'write'], { cwd: target, encoding: 'utf8' })
  assert.equal(lock.status, 0, lock.stderr)
  const stateFile = path.join(target, '.brain', 'brain.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, kit: '2.2.0', atelier: LEGACY_VERSION }))
}

test('update: check, test on the side, apply, and roll back on failure', { skip: !modules && 'set ATELIER_MODULES' }, async () => {
  const home = tmp('update')
  const target = path.join(home, 'second-brain')
  const pkgs = fakeRegistry(home)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', BRAIN_NPM: path.join(here, 'fake-npm.mjs'), FAKE_PKGS: pkgs, FAKE_DEPS: modules, FAKE_TAGS: JSON.stringify({ latest: '0.2.0-alpha.12', alpha: FUTURE_VERSION }) }
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(KIT, 'brain.mjs'), ...args], { cwd: home, encoding: 'utf8', env: { ...env, ...extra } })
  let r = run(['setup', '--target', target])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  legacyInstall(target, env)
  writeExports(path.join(target, 'inbox'), { chatgpt: 5, claude: 2 })
  const inner = (args, extra) => spawnSync(process.execPath, [path.join(target, 'kit', 'brain.mjs'), ...args], { cwd: target, encoding: 'utf8', env: { ...env, ...extra } })
  assert.equal(inner(['refresh']).status, 0)
  const version = () => JSON.parse(fs.readFileSync(path.join(target, 'node_modules', '@mnstry', 'atelier', 'package.json'), 'utf8')).version
  const preserved = new Map((await allNotes(target)).concat(['knowledge-plan.json', 'atelier.project.json']).map(f => [f, fs.readFileSync(path.join(target, f), 'utf8')]))
  const assertPreserved = () => { for (const [f, text] of preserved) assert.equal(fs.readFileSync(path.join(target, f), 'utf8'), text, f) }

  r = inner(['update', '--check'])
  assert.ok(r.stdout.includes(`${FUTURE_VERSION} is available (you have ${LEGACY_VERSION})`), r.stdout)
  assert.match(r.stdout, /not been tested with it/)
  assert.doesNotMatch(r.stdout, /alpha\.12/, 'an older tagged release is never offered')
  assert.match(inner(['doctor']).stdout, new RegExp(`ℹ Atelier ${versionPattern(FUTURE_VERSION)} is available`))

  // A release that fails on this brain is refused and nothing changes.
  r = inner(['update', '--to', BROKEN_VERSION])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /✗ knowledge check/)
  assert.match(r.stdout, /nothing was changed/)
  assert.equal(version(), LEGACY_VERSION)
  assert.notEqual(inner(['update', '--apply']).status, 0, 'a failed candidate cannot be applied')
  assertPreserved()

  // The real pin is tested on the side, leaving the working version untouched.
  env.FAKE_TAGS = JSON.stringify({ latest: '0.2.0-alpha.12', alpha: ATELIER_VERSION })
  r = inner(['update'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /✓ knowledge check/)
  assert.match(r.stdout, new RegExp(`Invented test note for ${versionPattern(ATELIER_VERSION)}`))
  const candidate = JSON.parse(fs.readFileSync(path.join(target, '.brain', 'work', 'update-candidate.json'), 'utf8'))
  assert.equal(candidate.testedWithThisKit, true)
  assert.equal(version(), LEGACY_VERSION)

  // Apply with a failing install: the old version and settings come back.
  r = inner(['update', '--apply'], { FAKE_FAIL_INSTALL: ATELIER_VERSION })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, new RegExp(`${versionPattern(LEGACY_VERSION)} is back in place`))
  assert.equal(version(), LEGACY_VERSION)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).devDependencies['@mnstry/atelier'], LEGACY_VERSION)
  assertPreserved()

  r = inner(['update'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  r = inner(['update', '--apply'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, new RegExp(`Updated Atelier ${versionPattern(LEGACY_VERSION)} → ${versionPattern(ATELIER_VERSION)}`))
  assert.equal(version(), ATELIER_VERSION)
  const lock = JSON.parse(fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8'))
  assert.equal(lock.package.version, ATELIER_VERSION)
  assert.match(spawnSync('git', ['log', '--oneline', '-1'], { cwd: target, encoding: 'utf8' }).stdout, new RegExp(`Update Atelier ${versionPattern(LEGACY_VERSION)} to ${versionPattern(ATELIER_VERSION)}`))
  assert.equal(inner(['doctor']).status, 0)
  assert.equal((await allNotes(target)).length, 9, 'notes untouched')
  assertPreserved()

  // Re-running setup never downgrades a version newer than the kit pin.
  r = inner(['update', '--to', FUTURE_VERSION])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  r = inner(['update', '--apply'])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  r = run(['setup', '--target', target])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(version(), FUTURE_VERSION)
})

test('setup upgrades a 2.2.0 alpha.16 brain safely and preserves notes and settings', { skip: !modules && 'set ATELIER_MODULES' }, async () => {
  const home = tmp('kit-upgrade')
  const target = path.join(home, 'second-brain')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', BRAIN_NPM: path.join(here, 'fake-npm.mjs'), FAKE_PKGS: fakeRegistry(home), FAKE_DEPS: modules }
  const run = extra => spawnSync(process.execPath, [path.join(KIT, 'brain.mjs'), 'setup', '--target', target], { cwd: home, encoding: 'utf8', env: { ...env, ...extra } })
  assert.equal(run().status, 0)
  legacyInstall(target, env)
  const files = new Map([
    ['notes/my-notes/personal.md', '# Personal note\nKeep this.\n'],
    ['.brain/approved-tools.txt', 'my chosen tools\n'],
    ['.claude/settings.json', '{"customSetting":true}\n'],
    ['knowledge-plan.json', fs.readFileSync(path.join(target, 'knowledge-plan.json'), 'utf8')],
  ])
  for (const [f, text] of files) { fs.mkdirSync(path.dirname(path.join(target, f)), { recursive: true }); fs.writeFileSync(path.join(target, f), text) }
  const refreshed = spawnSync(process.execPath, [path.join(target, 'kit', 'brain.mjs'), 'refresh'], { cwd: target, env, encoding: 'utf8' })
  assert.equal(refreshed.status, 0, refreshed.stderr + refreshed.stdout)
  const pkgBefore = fs.readFileSync(path.join(target, 'package.json'), 'utf8')
  const lockBefore = fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8')
  let r = run({ FAKE_FAIL_INSTALL: ATELIER_VERSION })
  assert.notEqual(r.status, 0)
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), pkgBefore, 'failed kit upgrade keeps the old package pin')
  assert.equal(fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8'), lockBefore)
  r = run()
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'atelier.lock.json'), 'utf8')).package.version, ATELIER_VERSION)
  for (const [f, text] of files) assert.equal(fs.readFileSync(path.join(target, f), 'utf8'), text, f)
})

test('MNSTRY information is opt-in and local', { skip: !modules && 'set ATELIER_MODULES' }, async () => {
  const home = tmp('mnstry')
  const target = path.join(home, 'second-brain')
  fs.mkdirSync(target, { recursive: true })
  fs.symlinkSync(modules, path.join(target, 'node_modules'), 'dir')
  const run = args => spawnSync(process.execPath, [path.join(KIT, 'brain.mjs'), ...args], { cwd: target, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  assert.equal(run(['setup', '--target', target]).status, 0)
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).stdout
  const about = run(['mnstry'])
  assert.match(about.stdout, /You do not need MNSTRY for anything in this kit/)
  assert.match(about.stdout, /made by MNSTRY/)
  const check = run(['mnstry', '--readiness'])
  assert.match(check.stdout, /Nothing was sent anywhere/)
  assert.match(check.stdout, /Identity Map/)
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).stdout, before, 'the checklist writes nothing')
  // Nothing else in the everyday commands mentions MNSTRY.
  for (const args of [['status'], ['doctor'], ['refresh']]) assert.doesNotMatch(run(args).stdout, /MNSTRY/, args.join(' '))
})
