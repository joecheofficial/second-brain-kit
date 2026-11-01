# Second Brain Kit

One front door for a second brain that makes every Claude Code or Codex session smarter.

It installs three things together, at versions tested to work with each other:

- **The Organizer** ([allsorted-organizer](https://github.com/joecheofficial/allsorted-organizer)) builds your second brain: a folder of linked notes about your projects, people, companies and ideas, made from your own exports and documents.
- **Atelier** checks that brain and writes its relationship graph: every note, and every connection between them.
- **The wiring** puts that graph into every session, so your assistant already knows your work:
  - a **session briefing**: each new session starts with your most connected projects, the people you work with, and anything waiting for you;
  - a **prompt hook**: when you mention a project, person or company, its note and closest connections are added to the conversation;
  - a **`second-brain` skill** that answers "who", "what do I know about" and "how is X connected to Y" from the graph, then reads the notes and names its sources.

Everything stays on your computer. Nothing is sent anywhere.

## Needs

Node.js 22.18 or newer (or 24.13.1 or newer) and git. Mac, Windows or Linux.

## Install

```sh
git clone https://github.com/joecheofficial/second-brain-kit.git ~/second-brain-kit
node ~/second-brain-kit/bin/brain.mjs setup --root ~/brain_dump_map
```

`setup` clones the Organizer to `~/allsorted-organizer` at the pinned version, installs the pinned Atelier into `<root>/.external/atelier`, and creates the brain with its Obsidian map settings. Then build your brain with the Organizer (see its README), and when the graph exists:

```sh
node ~/second-brain-kit/bin/brain.mjs install --root ~/brain_dump_map            # Claude Code: skill + two hooks
node ~/second-brain-kit/bin/brain.mjs install --root ~/brain_dump_map --host codex  # Codex: skill
node ~/second-brain-kit/bin/brain.mjs check   --root ~/brain_dump_map            # prove it all works
```

`install` backs up `~/.claude/settings.json` first, keeps every other setting and hook, and can be run again safely. `uninstall` removes only what it added.

## Ask your brain

```sh
B="node $HOME/second-brain-kit/bin/brain.mjs"
$B about "Maya Lopez" --root ~/brain_dump_map        # the note and everything one step away
$B find "bakery" --root ~/brain_dump_map             # search titles and summaries
$B path "Tom Reed" -- "Sunrise Bakery" --root ~/brain_dump_map   # how two things connect
$B recent --root ~/brain_dump_map                    # who and what you worked on lately
$B briefing --root ~/brain_dump_map                  # the session briefing
```

## Keep it current

```sh
node ~/second-brain-kit/bin/brain.mjs update --root ~/brain_dump_map
```

Pulls the kit, moves the Organizer and Atelier to the versions in `kit.json`, refreshes the wiring and runs `check`. Your daily brain keeper should run this first.

## Safety

- The hooks only read. They always exit cleanly, print nothing when nothing matches or the graph is missing, and finish in well under a second, so they can never block a session.
- What the hooks add is marked as background, never instructions.
- `setup` never touches an Organizer folder that has local edits.

## Tests

```sh
node --test tests/*.test.mjs
```

Personal use license, see [LICENSE](LICENSE). Made by Joe Che for the Mastermind.
