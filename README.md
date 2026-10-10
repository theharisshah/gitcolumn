# GitColumn

A Tower-style desktop Git client built with Electron, React and TypeScript. It drives the
real `git` CLI, so it works with your existing config, credential helpers, SSH agent and hooks.

## Run it

```bash
npm install
npm start        # production build + launch the desktop app
npm run dev      # Electron + Vite with hot reload
npm run web      # same UI in a browser at http://127.0.0.1:5199 (no Electron)
npm test         # backend tests against real temporary repositories
```

## Features

- **Working Copy** — tri-state staging checkboxes, multi-select, stage/unstage/discard whole
  files, **hunks or individual lines** (click or drag in the diff gutter), word-level change
  highlighting, ignore-whitespace toggle, auto-refresh while you edit.
- **Commit composer** — subject/body with length hint, amend, ⌘↩ to commit, offers to stage
  everything when nothing is staged, prompts for your identity if git doesn't know it.
- **History** — virtualized commit list with a lane graph, branch/remote/tag badges (local and
  upstream folded together when in sync), current branch or all branches, search by message,
  author or code content (`-S`), stacked per-file diffs for the selected commit.
- **Branches, remotes, tags** in a filterable sidebar with folder grouping (`feature/…`),
  ahead/behind counts and context menus: checkout, merge, rebase, push / force-push (with lease),
  track upstream, rename, delete (local and remote), create branch/tag from anything.
- **Toolbar** — Fetch, Pull (merge or rebase, right-click to choose), Push, Branch, Merge, Stash,
  Pop, plus a quick branch switcher.
- **Commit actions** — checkout (detached), cherry-pick, revert, reset soft/mixed/hard, undo last
  commit, copy SHA.
- **Conflicts** — banner for merge/rebase/cherry-pick/revert in progress with Abort / Skip /
  Continue, conflict view with highlighted ours/theirs regions, resolve with either side or mark
  resolved.
- **Stashes** — save (optionally with untracked files / keep index), browse diffs, apply, pop, drop.
- Multiple repositories in tabs, recent repositories, clone / init, light and dark themes.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘1 / ⌘2 / ⌘3 | Working Copy / History / Stashes |
| ⌘R | Refresh |
| ⌘O | Open repository |
| ⌘⇧F / ⌘⇧L / ⌘⇧P | Fetch / Pull / Push |
| ⌘⇧B | New branch |
| ⌘⇧S | Stash changes |
| ↑ ↓, Space, ⌘⌫ | Move through files, stage/unstage, discard (file list) |
| ⌘↩ | Commit (composer) or confirm (dialogs) |

## Architecture

```
shared/types.ts      types used by both sides
server/git.ts        spawns git (no terminal prompts, timeouts, output caps)
server/parse.ts      parsers for status v2, for-each-ref, log, diffs, numstat…
server/patch.ts      builds partial patches for hunk / line staging
server/api.ts        every operation as a named handler
server/http.ts       exposes the handlers over HTTP for browser mode (dev only)
electron/            main process (IPC → handlers, dialogs, trash) and preload bridge
src/                 React renderer: repo context, actions, views, dialogs
```

The renderer calls `window.gitcolumn.invoke(method, args)` in Electron and falls back to
`POST /api/<method>` in browser mode, so the same UI runs in both.

## Not implemented yet

Interactive rebase, blame and file history views, submodule management, Git LFS, syntax
highlighting and image diffs, undo, and packaging into a signed `.app` (add electron-builder or
Electron Forge for that). Network operations rely on your credential helper or SSH agent; there
is no in-app password prompt.
