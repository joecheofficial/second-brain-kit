# Start here: your second brain

By the end of the session your assistant will be able to search everything
you have said to ChatGPT and Claude, plus the email, documents and calendar
items you choose. Ask it from your laptop or your phone ("what did I decide
about pricing in March?"), and it finds the conversation and tells you where
it came from.

Everything stays on your computer, in one folder (`~/second-brain`). Nothing
is uploaded or shared.

## What you need

- Your laptop with Claude Code or Codex working (your orchestrating agent).
- Your ChatGPT and/or Claude export zips in your Downloads folder. If you have
  not requested them yet, see `BEFORE-THE-SESSION.md`; they can take hours to arrive.
- About 2 hours. The setup itself takes about 45 minutes; the rest of the
  time goes on email and files, and on trying it out.

## Three steps

1. **Unzip this kit** into your Downloads folder. You should see a folder
   called `second-brain-kit` with this page inside it.
2. **Open Claude Code (or Codex)** and paste in everything below the line in
   `SETUP-PROMPT.md`. Answer its questions as it goes.
3. **Try it.** When it finishes, ask your assistant something only your old
   chats would know.

Some of the work keeps going after the session: summaries of older
conversations are added a few hundred at a time each night, newest first.
Search already works on everything from the start; summaries make answers
quicker and the map richer.

## Everyday use

You mostly just ask your assistant. If you want to do things yourself, open a
terminal in `~/second-brain`:

| To… | Run |
| --- | --- |
| find something | `node kit/brain.mjs find "words you remember"` |
| see everything as a night-sky map | `node kit/brain.mjs map`, then press **3D** to see your years stacked |
| add a newer export | put the zip in `inbox/`, then `node kit/brain.mjs refresh` |
| check everything is healthy | `node kit/brain.mjs doctor` |
| check for an Atelier update | `node kit/brain.mjs update --check` |

If something goes wrong, see `TROUBLESHOOTING.md`, or paste `SETUP-PROMPT.md`
again: it checks what is done and carries on.

## Keeping it up to date

Atelier, the open-source engine underneath, gets new releases. Your organizer
checks once a week and tells you; it never installs one on its own. When you
want to update, ask your assistant to "update Atelier in my second brain", or run
`node kit/brain.mjs update`. That tests the new release on your brain first
and shows you what changed. Nothing switches until you run
`node kit/brain.mjs update --apply`, and if anything fails, it goes back to
the version you had. Updates never touch your notes.

When your facilitator sends a newer kit, unzip it and paste `SETUP-PROMPT.md` again.
It updates the tools in place and keeps everything.

## Your data

- The folder is private. Never put it on GitHub or in a shared drive. Sending
  to GitHub is switched off for it.
- You can open, edit or delete any note; they are ordinary text files in `notes/`.
- Local history means mistakes can be undone. Ask your assistant to "undo the
  last refresh in my second brain" if something looks wrong.
- To remove everything, delete the `~/second-brain` folder and the "My second
  brain" section from your assistant's instructions.

## Who made this

The kit and Atelier are made by [MNSTRY](https://mnstry.ai). Atelier is open
source (Apache-2.0). You don't need an account, and nothing here sends anything
to MNSTRY. If your notes grow into something you want to offer others, such as
a method, a programme or a course, `node kit/brain.mjs mnstry` explains what
MNSTRY does. Otherwise you can ignore it; your second brain is complete as it is.
