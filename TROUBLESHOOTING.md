# If something goes wrong

First, run `node ~/second-brain/kit/brain.mjs doctor`. It checks the setup and
says what to do for each problem. Pasting `SETUP-PROMPT.md` again is always
safe: it picks up where it stopped and never deletes anything.

| What you see | What to do |
| --- | --- |
| `This needs Node.js 24` or `command not found: node` | Install Node 24 LTS from nodejs.org, close the terminal, open a new one, and paste the setup prompt again. |
| A Mac pop-up about "command line developer tools" | Click **Install** and wait for it to finish, then continue. |
| `npm install did not finish` | Usually the internet connection or a company proxy. Try another network, then run setup again. |
| My export email never came | It can take up to a day for heavy users. Carry on without it; drop the zip in `~/second-brain/inbox/` later and run `node kit/brain.mjs refresh` (or let the nightly run do it). |
| The export link says expired | Request a new export; links last about 24 hours. |
| `No conversations.json found` | That zip is not a chat export (or is still downloading). ChatGPT and Claude exports both contain `conversations.json`. |
| `is very large … run again with more memory` | Run the command it shows, starting with `NODE_OPTIONS=--max-old-space-size=8192`. |
| Search finds nothing | Try fewer or different words, a name, or `--since`. Check `node kit/brain.mjs status` that notes were imported. |
| The assistant does not use my brain | Check the "My second brain" section is at the end of `~/.claude/CLAUDE.md` (Claude Code) or `~/.codex/AGENTS.md` (Codex), then start a new session. |
| On my phone it cannot find anything | Your phone session must be connected to this laptop (for example Remote Control), not a cloud session. Cloud sessions cannot see files on your laptop. |
| `Atelier graph did not build` | Run `node kit/brain.mjs doctor` and send the output to your facilitator. Search and the index still work. |
| The 3D button says it needs WebGL, or 3D is very slow | Use the 2D map; it has everything. 3D needs a browser with graphics acceleration (Chrome, Safari or Edge on a normal laptop). |
| The map is blank | The map needs a browser with WebGL. Use **Text view** in the top right, or try Chrome. With very many notes, pick an area first. |
| A summary is wrong | Ask your assistant to correct the summary of that note and mark it `enrichment: "done"`, so helpers leave it alone. |
| `update` says a check failed | Nothing was changed. Stay on your current version; your facilitator may send a newer kit. |
| `The update … did not complete` | It put your previous version back. Run `node kit/brain.mjs doctor`; if it is all ticks, carry on as before. |
| `update --check` cannot reach npm | Try again later or on another network. Your brain works the same without updating. |
| Something looks broken after a refresh | Ask your assistant: "show me the last checkpoints in ~/second-brain and undo the last refresh". History is local and kept. |

Still stuck? Copy the error and the output of `doctor` to your facilitator. Never
send the contents of your notes.

## A note says "Held by the safety filter"

It looked written to trick an assistant, so no helper read it and it adds no people or connections to your graph. The list is in `_review/HELD.md`. If one is fine, run `node kit/brain.mjs guard release <note path>` and it is summarised the next night. If the thread changes, it is checked again.

## The nightly run says "Second brain safety lock"

That is the lock doing its job: the scheduled keeper can read your apps but never send, change or open the internet. Each refusal is in `.brain/guard.log`. Your own chats are not affected. If keeper.log stays empty and the log shows the same refusal every night, run `node kit/brain.mjs doctor` and ask your facilitator.
