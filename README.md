# Second Brain Kit

A private second brain for your AI assistant, powered by MNSTRY Atelier.

This is the Masterminds HQ distribution of the Second brain kit that Erik Desrosiers and MNSTRY built on [Atelier](https://github.com/MNSTRY/atelier). It turns your ChatGPT and Claude exports, email, documents and calendar into one searchable folder of Markdown notes on your own computer, keeps it fresh every night, and puts it into every session with your assistant.

**Students:** follow the prompt on your course page. If you are here on your own, read [START-HERE.md](START-HERE.md).

```sh
git clone https://github.com/joecheofficial/second-brain-kit.git ~/second-brain-kit
node ~/second-brain-kit/kit/brain.mjs setup --target ~/brain_dump_map
```

## What this distribution adds to the kit

- **A relationship graph.** People and projects that share notes are linked to each other, in the Atelier graph and on their hub pages. `node kit/brain.mjs map --people` opens the map of them. The everyday map and its 3D view are unchanged.
- **The wiring.** `node kit/brain.mjs wire` adds a `second-brain` skill and, for Claude Code, two hooks: a briefing when a session starts, and the right connections whenever you name a project or person. It also allows Claude to read and write this brain folder and run this kit's own commands without asking, so the nightly run does not stop at a prompt; nothing else is opened up. It backs up `~/.claude/settings.json` and keeps everything else; `unwire` removes all of it. Use `--host codex` for Codex (skill only) and `--check` to test it.
- **A live progress panel.** `node kit/brain.mjs progress` serves a small local page with a progress bar, the current step and running counts during the first build. It reads `_progress.md` and uses no model.
- **One spelling per name.** Helpers read `.brain/work/my-names.md`, so parallel helpers connect the same people and projects.
- **Expansion colours** on the map.

## Tests

```sh
ATELIER_MODULES=<folder>/node_modules node --test tests/kit.test.mjs tests/wiring.test.mjs
```

`ATELIER_MODULES` is a `node_modules` folder with `@mnstry/atelier@0.2.0-alpha.16` installed. Node 24, or 22.18 and later.

Apache-2.0, see [LICENSE](LICENSE). MNSTRY and Atelier are trademarks of MNSTRY, see [TRADEMARKS.md](TRADEMARKS.md).
