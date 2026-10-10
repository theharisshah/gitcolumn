# GitColumn

A Tower-style desktop Git client built with Electron, React and TypeScript. It drives the
real `git` CLI, so it works with your existing config, credential helpers, SSH agent and hooks.

![GitColumn icon](build/icons/128x128.png)

## Install

Download the installer for your platform from the `release/` folder (or a GitHub Release):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `GitColumn-<version>-arm64.dmg` / `.zip` |
| macOS (Intel) | `GitColumn-<version>-x64.dmg` / `.zip` |
| Windows | `GitColumn-Setup-<version>.exe` (picks x64/arm64 automatically), or `-x64.exe` / `-arm64.exe` |
| Linux | `GitColumn-<version>-x86_64.AppImage` / `-arm64.AppImage`, `GitColumn-<version>-amd64.deb` / `-arm64.deb` |

Unless built with signing certificates (see below), macOS builds are ad-hoc signed and not notarized:
the first time you open a downloaded copy, right-click the app and choose **Open** (or run
`xattr -dr com.apple.quarantine /Applications/GitColumn.app`). Unsigned Windows installers show a
SmartScreen warning — choose **More info → Run anyway**.

## Develop

```bash
npm install
npm run dev      # Electron + Vite with hot reload
npm run web      # same UI in a browser at http://127.0.0.1:5199 (no Electron)
npm start        # production build + launch
npm test         # backend tests against real temporary repositories
```

## Build releases

```bash
npm run dist:mac     # release/*.dmg + *.zip for arm64 and x64
npm run dist:win     # release/*.exe (NSIS installer) for x64 and arm64
npm run dist:linux   # release/*.AppImage + *.deb for x64 and arm64
npm run icons        # regenerate build/icon.{png,icns,ico} + build/icons/ from build/icon.svg
```

Pushing a tag like `v1.0.0` runs `.github/workflows/release.yml`, which builds all three
platforms and attaches the installers to a draft GitHub Release.

**Signing.** Without a certificate, macOS builds are ad-hoc signed so they run on Apple Silicon.
To sign with a Developer ID and notarize, set `CSC_LINK` (base64 .p12 or path), `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` — locally or as repository secrets
(`MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, …) for CI. `scripts/dist.mjs` switches
to full signing with the hardened runtime automatically when a certificate is present.

## Features

- **Working Copy** — tri-state staging checkboxes, multi-select, stage/unstage/discard whole files,
  **hunks or individual lines** (click or drag in the diff gutter), syntax-highlighted diffs with
  word-level changes, side-by-side / onion-skin **image diffs**, Git LFS pointer detection.
- **Commit composer** — subject/body with length hint, amend, ⌘↩ to commit, offers to stage
  everything when nothing is staged, prompts for your identity if git doesn't know it.
- **History** — virtualized commit list with a lane graph, branch/remote/tag badges, current branch
  or all branches, search by message, author or code (`-S`), stacked per-file diffs.
- **Rewrite history** — interactive rebase editor (pick, reword, edit, squash, fixup, drop,
  drag to reorder) plus one-click *Edit Message*, *Squash/Fixup into Parent* and *Drop Commit*.
- **File history & blame** — every commit that touched a file (following renames) with its diff;
  blame with syntax highlighting, age colouring and *Blame Previous Revision*.
- **Undo (⌘Z)** — staging, discards (including untracked files), commits, amends, checkouts,
  branch create/delete/rename, merges, rebases, cherry-picks, reverts, resets, stashes and tags.
  Success toasts carry an **Undo** button.
- **Branches, remotes, tags, submodules** in a filterable sidebar with context menus: checkout,
  merge, rebase, push / force-push (with lease), track upstream, rename, delete, open a submodule
  in its own tab, initialize/update submodules.
- **Credentials** — HTTPS usernames/passwords, SSH passphrases and host-key confirmations are asked
  for inside the app (askpass bridge); your credential helper/keychain still stores them.
- **Conflicts** — banner for merge/rebase/cherry-pick/revert in progress with Abort / Skip /
  Continue, conflict view with highlighted ours/theirs regions, resolve with either side.
- **Stashes** — save (optionally with untracked files / keep index), browse diffs, apply, pop, drop.
- **Settings** — commit author (global or per repo), remotes, pull strategy, automatic fetch,
  syntax highlighting, Git LFS (tracked patterns, install, pull), submodules, `.gitignore` editor.
- Multiple repositories in tabs, recent repositories, clone / init, light and dark themes.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘1 / ⌘2 / ⌘3 | Working Copy / History / Stashes |
| ⌘, | Settings |
| ⌘Z | Undo the last git operation (outside text fields) |
| ⌘R | Refresh |
| ⌘O | Open repository |
| ⌘⇧F / ⌘⇧L / ⌘⇧P | Fetch / Pull / Push |
| ⌘⇧B | New branch |
| ⌘⇧S | Stash changes |
| ↑ ↓, Space, ⌘⌫ | Move through files, stage/unstage, discard (file list) |
| ⌘↩ | Commit (composer), confirm (dialogs), start rebase |

## Architecture

```
shared/types.ts      types used by both sides
server/git.ts        spawns git (no terminal prompts, timeouts, output caps, per-call env)
server/parse.ts      parsers: status v2, refs, log, diffs, blame, submodules, LFS…
server/patch.ts      builds partial patches for hunk / line staging
server/api.ts        every operation as a named handler (incl. rebase plans and undo snapshots)
server/http.ts       exposes the handlers over HTTP for browser mode (dev only)
electron/            main process (IPC, menu, askpass bridge, trash) and preload bridge
src/                 React renderer: repo context + undo stack, actions, views, dialogs
scripts/             dev server, Electron bundling, icon generation, release wrapper, tests
build/               icon source (icon.svg) and generated platform icons
```

The renderer calls `window.gitcolumn.invoke(method, args)` in Electron and falls back to
`POST /api/<method>` in browser mode, so the same UI runs in both.

Undo works by snapshotting before an operation: the index is saved with `git write-tree`, working
tree files with `git hash-object -w`, and refs by hash. Undo restores exactly that state, and
refuses if the repository moved on in the meantime. The undo history lives in memory per window.

## Known limitations

- Git LFS management needs `git-lfs` installed; without it LFS files show as pointer files.
- Interactive rebase refuses ranges containing merge commits (it would flatten them).
- Undo history is not persisted across restarts; pushes and other remote changes can't be undone.
- Windows and Linux installers build cleanly (locally on macOS and in CI) but have only been
  exercised on macOS so far.
