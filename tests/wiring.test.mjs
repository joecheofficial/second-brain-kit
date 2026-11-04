// The Mastermind layer: hub-to-hub relationships, the session hooks and their install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeHubs, writeIndex } from '../kit/lib/catalog.mjs'
import { mentions, briefing } from '../kit/lib/wiring.mjs'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit', 'brain.mjs')
const note = (id, people, projects, date = '2026-10-20') => ({ path: `notes/chats/chatgpt/2026/${id}.md`, id: `chat:${id}`, title: id, date, source: 'chatgpt', area: 'chats/chatgpt', summary: '', topics: [], people, projects, concepts: [], enrichment: 'done', bytes: 1, managed: true })

function brain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-'))
  const notes = [
    note('a', ['Maya Lopez'], ['Sunrise Bakery']), note('b', ['Maya Lopez'], ['Sunrise Bakery']),
    note('c', ['Maya Lopez', 'Tom Reed'], ['Founder Stories']), note('d', ['Maya Lopez', 'Tom Reed'], ['Founder Stories']),
    note('e', ['Tom Reed'], []), note('f', [], ['Business']), note('g', [], ['Business']),
  ]
  const hubs = writeHubs(root, notes)
  writeIndex(root, { entries: [...notes, ...hubs], problems: [] })
  return { root, hubs: JSON.parse(fs.readFileSync(path.join(root, 'index', 'hubs.json'), 'utf8')) }
}

test('hubs that share notes are connected, in the graph and on the page', () => {
  const { root, hubs } = brain()
  const maya = hubs.find(h => h.name === 'Maya Lopez')
  assert.deepEqual(maya.links.map(l => l.name).sort(), ['Founder Stories', 'Sunrise Bakery', 'Tom Reed'])
  const text = fs.readFileSync(path.join(root, 'notes/hubs/people/maya-lopez.md'), 'utf8')
  assert.match(text, /"hub:projects:sunrise-bakery"/)
  assert.match(text, /## Connected to/)
  assert.match(text, /\(2 shared notes\)/)
  assert.equal(hubs.find(h => h.name === 'Business').links.length, 0)
})

test('mentions skip common words and prefer specific names', () => {
  const { hubs } = brain()
  assert.deepEqual(mentions(hubs, 'Update Maya Lopez on Sunrise Bakery').map(h => h.name), ['Sunrise Bakery', 'Maya Lopez'])
  assert.deepEqual(mentions(hubs, 'how is the business going'), [])
})

test('the briefing lists people with their work and stays short', () => {
  const { root, hubs } = brain()
  const text = briefing(root, hubs)
  assert.match(text, /Maya Lopez/)
  assert.match(text, /Sunrise Bakery/)
  assert.ok(text.split('\n').length <= 25)
})

const hook = (root, mode, input) => spawnSync(process.execPath, [BIN, 'hook', mode, '--root', root], { input, encoding: 'utf8' })

test('hooks add context, stay silent otherwise and never fail', () => {
  const { root } = brain()
  const hit = hook(root, 'prompt', JSON.stringify({ prompt: 'Email Tom Reed' }))
  assert.equal(hit.status, 0)
  assert.match(hit.stdout, /connected to: .*Maya Lopez/)
  for (const input of [JSON.stringify({ prompt: 'weather today' }), 'not json', '']) {
    const r = hook(root, 'prompt', input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  const missing = hook('/nonexistent-brain', 'session-start', '')
  assert.equal(missing.status, 0)
  assert.equal(missing.stdout, '')
})

function wireIn(home, root, ...args) {
  fs.mkdirSync(path.join(root, '.brain'), { recursive: true })
  fs.writeFileSync(path.join(root, '.brain', 'brain.json'), '{}')
  return spawnSync(process.execPath, [BIN, ...args, '--brain', root], { encoding: 'utf8', env: { ...process.env, SECOND_BRAIN_KIT_HOME: home } })
}

test('wire is idempotent, keeps other settings, and unwire restores them', () => {
  const { root } = brain()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  const file = path.join(home, '.claude', 'settings.json')
  const original = { theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }
  fs.writeFileSync(file, JSON.stringify(original))
  assert.equal(wireIn(home, root, 'wire').status, 0)
  assert.equal(wireIn(home, root, 'wire').status, 0)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.theme, 'dark')
  const commands = Object.values(after.hooks).flat().flatMap(g => g.hooks).map(h => h.command)
  assert.equal(commands.filter(c => c === 'echo mine').length, 1)
  assert.equal(commands.filter(c => c.includes('--kit second-brain-kit')).length, 2)
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/second-brain/SKILL.md')))
  assert.equal(wireIn(home, root, 'unwire').status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original)
})

test('wire refuses a settings file that is not valid JSON', () => {
  const { root } = brain()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken')
  assert.equal(wireIn(home, root, 'wire').status, 1)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ broken')
})

test('Codex gets the skill in ~/.agents/skills and no hooks', () => {
  const { root } = brain()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbk-home-'))
  assert.equal(wireIn(home, root, 'wire', '--host', 'codex').status, 0)
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/second-brain/SKILL.md')))
  assert.ok(!fs.existsSync(path.join(home, '.claude/settings.json')))
})
