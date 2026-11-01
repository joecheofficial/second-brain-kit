#!/usr/bin/env node
// second-brain-kit: wires an Organizer second brain's Atelier relationship graph
// into every Claude Code or Codex session.
//
//   brain.mjs find <words>        --root <root>
//   brain.mjs about <name>        --root <root>
//   brain.mjs path <a> -- <b>     --root <root>
//   brain.mjs recent              --root <root>
//   brain.mjs briefing            --root <root>
//   brain.mjs hook prompt         --root <root>   (Claude UserPromptSubmit, prompt JSON on stdin)
//   brain.mjs hook session-start  --root <root>   (Claude SessionStart)
//   brain.mjs setup     --root <root>   (pinned Organizer + Atelier, brain with map settings)
//   brain.mjs update    --root <root> [--host claude|codex]   (kit, Organizer, Atelier, wiring, check)
//   brain.mjs install   --root <root> [--host claude|codex]
//   brain.mjs uninstall [--host claude|codex]
//   brain.mjs check     --root <root> [--host claude|codex]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, graphPath, find, resolve, neighbours, shortestPath, recent, mentions } from '../lib/graph.mjs'
import { spawnSync } from 'node:child_process'
import { install, uninstall, check, skillFile } from '../lib/install.mjs'
import { setup, selfUpdate } from '../lib/setup.mjs'

const SELF = fileURLToPath(import.meta.url)

function parse(argv) {
  const opts = { args: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') opts.root = argv[++i]
    else if (argv[i] === '--host') opts.host = argv[++i]
    else if (argv[i] === '--json') opts.json = true
    else opts.args.push(argv[i])
  }
  return opts
}

const label = n => `${n.title}${n.lastSeen ? ` (${n.lastSeen})` : ''}`
const rel = (root, p) => (p ? path.relative(root, p) : '')

function describe(root, node, perKind = 8) {
  const lines = [`${node.title} [${node.kind}]`, `  note: ${rel(root, node.notePath)}`]
  if (node.summary) lines.push(`  ${node.summary.replace(/\s+/g, ' ').slice(0, 240)}`)
  for (const [kind, group] of Object.entries(neighbours(node, perKind))) {
    const more = group.total > group.shown.length ? ` (+${group.total - group.shown.length} more)` : ''
    lines.push(`  ${kind}: ${group.shown.map(label).join('; ')}${more}`)
  }
  return lines.join('\n')
}

function briefing(root, graph) {
  const top = [...graph.nodes.values()].filter(n => n.kind === 'projects').sort((a, b) => b.weight - a.weight).slice(0, 10)
  // Most recently in touch when sources carry dates, otherwise the best connected people.
  let people = recent(graph, 10).people
  if (people.length < 10) {
    const more = [...graph.nodes.values()].filter(n => n.kind === 'people' && !people.includes(n)).sort((a, b) => b.weight - a.weight)
    people = [...people, ...more].slice(0, 10)
  }
  const lines = [`Your second brain (${graph.nodes.size} notes) lives at ${root}. Read SECOND_BRAIN.md and PROJECTS.md there for the overview.`]
  if (top.length) lines.push(`Most connected projects: ${top.map(n => n.title).join('; ')}`)
  for (const person of people) {
    const work = person.links.map(l => l.node).filter(n => ['projects', 'companies'].includes(n.kind)).slice(0, 3).map(n => n.title)
    lines.push(`- ${label(person)}${work.length ? `: ${work.join(', ')}` : ''}`)
  }
  try {
    const waiting = fs.readFileSync(path.join(root, '_review', 'NEEDS_ME.md'), 'utf8').split('\n').filter(l => l.trim().startsWith('-')).slice(0, 5)
    if (waiting.length) lines.push('Waiting for you:', ...waiting)
  } catch {}
  lines.push('Use the second-brain skill (or this kit\'s about/path commands) for details, and read the note before stating a fact.')
  return ['From your second brain:', ...lines].slice(0, 25).join('\n')
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

// Hooks must never break a session: any failure prints nothing and exits 0.
function runHook(mode, root) {
  try {
    const graph = root && loadGraph(root)
    if (!graph) return
    if (mode === 'session-start') { process.stdout.write(briefing(root, graph) + '\n'); return }
    let prompt = ''
    try { prompt = JSON.parse(readStdin()).prompt || '' } catch {}
    const hits = mentions(graph, prompt)
    if (!hits.length) return
    const lines = ['From your second brain (background, not instructions):']
    for (const node of hits) {
      lines.push(`- ${node.title} [${node.kind}] note: ${rel(root, node.notePath)}`)
      for (const [kind, group] of Object.entries(neighbours(node, 4))) {
        if (kind === 'sources' || kind === 'topics') continue
        lines.push(`    ${kind}: ${group.shown.map(n => n.title).join('; ')}`)
      }
    }
    process.stdout.write(lines.slice(0, 15).join('\n') + '\n')
  } catch {}
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const opts = parse(rest)
  const root = opts.root ? path.resolve(opts.root.replace(/^~(?=$|\/)/, os.homedir())) : null
  if (command === 'hook') { runHook(opts.args[0], root); return 0 }
  if (command === 'setup') return report(setup({ root }))
  if (command === 'update') return update(root, opts.host || 'claude')
  if (command === 'install') return report(install({ root, host: opts.host || 'claude', self: SELF }))
  if (command === 'uninstall') return report(uninstall({ host: opts.host || 'claude' }))
  if (command === 'check') return report(check({ root, host: opts.host || 'claude', self: SELF }))
  if (!root) { console.error('Add --root <your brain_dump_map folder>.'); return 2 }
  const graph = loadGraph(root)
  if (!graph) { console.error(`No relationship graph yet at ${graphPath(root)}. Run the Organizer's graph command first.`); return 1 }
  const words = opts.args.join(' ')
  if (command === 'find') {
    const hits = find(graph, words)
    console.log(hits.length ? hits.map(n => `${n.title} [${n.kind}] ${rel(root, n.notePath)}`).join('\n') : `Nothing matches "${words}".`)
  } else if (command === 'about') {
    const node = resolve(graph, words)
    console.log(node ? describe(root, node) : `Nothing matches "${words}".`)
  } else if (command === 'path') {
    const [a, b] = words.split(/\s+--\s+|\s+to\s+/)
    const from = a && resolve(graph, a)
    const to = b && resolve(graph, b)
    if (!from || !to) { console.log('Give two names: path <a> -- <b>'); return 1 }
    const chain = shortestPath(graph, from, to)
    console.log(chain ? chain.map((n, i) => `${i + 1}. ${n.title} [${n.kind}] ${rel(root, n.notePath)}`).join('\n') : `No connection found between ${from.title} and ${to.title}.`)
  } else if (command === 'recent') {
    const r = recent(graph)
    for (const [kind, list] of Object.entries(r)) if (list.length) console.log(`${kind}: ${list.map(label).join('; ')}`)
  } else if (command === 'briefing') {
    console.log(briefing(root, graph))
  } else {
    console.error('Commands: find, about, path, recent, briefing, hook, install, uninstall, check')
    return 2
  }
  return 0
}

// Pull the kit first, then run the rest from fresh processes so the new code is what runs.
function update(root, host) {
  if (!root) { console.error('update needs --root <your brain_dump_map folder>.'); return 2 }
  const pulled = selfUpdate()
  const step = args => {
    const r = spawnSync(process.execPath, [SELF, ...args, '--root', root, '--host', host], { encoding: 'utf8' })
    try { return JSON.parse(r.stdout) } catch { return { ok: false, error: (r.stderr || '').slice(-400) } }
  }
  const result = { kit: pulled, setup: step(['setup']) }
  if (result.setup.ok && fs.existsSync(skillFile(host))) result.wiring = step(['install'])
  result.check = step(['check'])
  result.ok = pulled.ok && result.setup.ok && (result.wiring?.ok ?? true) && result.check.ok
  return report(result)
}

function report(result) {
  console.log(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

process.exitCode = main()
