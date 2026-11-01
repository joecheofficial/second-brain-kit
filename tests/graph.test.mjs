import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadGraph, find, resolve, shortestPath, mentions, neighbours } from '../lib/graph.mjs'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'brain.mjs')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-'))
  const node = (kind, slug, title) => ({ id: `brain:${kind}-${slug}`, title, summary: `${title} summary`, path: `${kind}/${slug}.md` })
  const nodes = [
    node('people', 'maya-lopez', 'Maya Lopez'),
    node('people', 'tom-reed', 'Tom Reed'),
    node('companies', 'sunrise-bakery', 'Sunrise Bakery'),
    node('projects', 'sunrise-bakery-website', 'Sunrise Bakery website'),
    node('projects', 'founder-stories', 'Founder Stories podcast'),
    node('projects', 'business', 'Business'),
    node('topics', 'projects', 'Projects'),
    node('sources', '2026-10-20-call', 'Call with Maya 2026-10-20'),
  ]
  const e = (a, b) => ({ source: `brain:${a}`, target: `brain:${b}`, type: 'related' })
  const edges = [
    e('people-maya-lopez', 'projects-sunrise-bakery-website'), e('people-maya-lopez', 'companies-sunrise-bakery'),
    e('projects-founder-stories', 'people-tom-reed'), e('projects-founder-stories', 'people-maya-lopez'),
    e('people-maya-lopez', 'sources-2026-10-20-call'),
    // A topic touching everything must not become a shortcut in paths.
    ...['people-tom-reed', 'companies-sunrise-bakery', 'projects-business'].map(n => e(n, 'topics-projects')),
  ]
  const dir = path.join(root, 'brain', 'atelier-output')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'knowledge.graph.json'), JSON.stringify({ nodes, edges }))
  return root
}

const hook = (root, mode, input) => spawnSync(process.execPath, [BIN, 'hook', mode, '--root', root], { input, encoding: 'utf8' })

test('loads nodes with kinds, dates and links', () => {
  const g = loadGraph(fixture())
  assert.equal(g.nodes.size, 8)
  const maya = g.nodes.get('brain:people-maya-lopez')
  assert.equal(maya.kind, 'people')
  assert.equal(maya.lastSeen, '2026-10-20')
  assert.deepEqual(Object.keys(neighbours(maya)).sort(), ['companies', 'projects', 'sources'])
})

test('find and resolve prefer exact titles over sources', () => {
  const g = loadGraph(fixture())
  assert.equal(resolve(g, 'maya lopez').title, 'Maya Lopez')
  assert.equal(find(g, 'sunrise')[0].kind === 'sources', false)
  assert.deepEqual(find(g, 'nothing like this'), [])
})

test('shortest path avoids walking through topics', () => {
  const g = loadGraph(fixture())
  const chain = shortestPath(g, resolve(g, 'Tom Reed'), resolve(g, 'Sunrise Bakery'))
  assert.deepEqual(chain.map(n => n.title), ['Tom Reed', 'Founder Stories podcast', 'Maya Lopez', 'Sunrise Bakery'])
})

test('mentions skip common words and prefer specific titles', () => {
  const g = loadGraph(fixture())
  assert.deepEqual(mentions(g, 'Update Maya Lopez on the Sunrise Bakery website').map(n => n.title), ['Sunrise Bakery website', 'Sunrise Bakery', 'Maya Lopez'])
  assert.deepEqual(mentions(g, 'how is the business going'), [])
})

test('hooks print context, stay silent on no match, and never fail', () => {
  const root = fixture()
  const hit = hook(root, 'prompt', JSON.stringify({ prompt: 'Email Tom Reed' }))
  assert.equal(hit.status, 0)
  assert.match(hit.stdout, /From your second brain/)
  assert.match(hit.stdout, /Founder Stories podcast/)
  for (const input of [JSON.stringify({ prompt: 'weather today' }), 'not json', '']) {
    const r = hook(root, 'prompt', input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  const missing = hook('/nonexistent-brain', 'session-start', '')
  assert.equal(missing.status, 0)
  assert.equal(missing.stdout, '')
  const brief = hook(root, 'session-start', '')
  assert.equal(brief.status, 0)
  assert.match(brief.stdout, /Maya Lopez/)
  assert.ok(brief.stdout.trim().split('\n').length <= 25)
})

test('install is idempotent, keeps other settings, and uninstall restores them', () => {
  const root = fixture()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  const settingsFile = path.join(home, '.claude', 'settings.json')
  const original = { theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }
  fs.writeFileSync(settingsFile, JSON.stringify(original))
  const env = { ...process.env, SECOND_BRAIN_KIT_HOME: home }
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env })
  assert.equal(run('install', '--root', root).status, 0)
  assert.equal(run('install', '--root', root).status, 0)
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(after.theme, 'dark')
  const commands = Object.values(after.hooks).flat().flatMap(g => g.hooks).map(h => h.command)
  assert.equal(commands.filter(c => c === 'echo mine').length, 1)
  assert.equal(commands.filter(c => c.includes('--kit second-brain-kit')).length, 2)
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'second-brain', 'SKILL.md')))
  assert.equal(run('uninstall').status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), original)
})

test('install refuses a settings file that is not valid JSON', () => {
  const root = fixture()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken')
  const r = spawnSync(process.execPath, [BIN, 'install', '--root', root], { encoding: 'utf8', env: { ...process.env, SECOND_BRAIN_KIT_HOME: home } })
  assert.equal(r.status, 1)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ broken')
})
