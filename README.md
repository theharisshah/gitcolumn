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

## Releasing

1. Bump `version` in `package.json`, commit, and tag it: `git tag v1.1.0 && git push origin v1.1.0`.
2. `.github/workflows/release.yml` builds macOS, Windows and Linux installers, adds a
   `SHA256SUMS.txt`, and attaches everything to the tag's GitHub Release — creating a **draft** if
   there is none yet, or replacing the files of an existing (draft or published) release.
3. Review the draft's notes and publish it.

`.github/workflows/ci.yml` runs the typecheck and tests on macOS, Linux and Windows for every push
(on Windows, test failures are reported but don't fail the run yet).

**macOS signing and notarization.** Without a certificate, macOS builds are ad-hoc signed so they
run on Apple Silicon, and users have to right-click → Open the first time. To ship signed,
notarized builds you need an Apple Developer account:

| Repository secret | What it is |
| --- | --- |
| `MAC_CERTIFICATE_P12_BASE64` | "Developer ID Application" certificate + key exported from Keychain as .p12, then `base64 -i cert.p12` |
| `MAC_CERTIFICATE_PASSWORD` | The password chosen when exporting the .p12 |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | The 10-character team ID |

Locally, set `CSC_LINK` (path or base64 of the .p12), `CSC_KEY_PASSWORD` and the three `APPLE_*`
variables. `scripts/dist.mjs` switches to full signing with the hardened runtime and notarization
automatically when a certificate is present.

**Windows signing.** Set `WIN_CSC_LINK` (base64 or path of a code-signing .pfx) and
`WIN_CSC_KEY_PASSWORD` as secrets (or locally). `CSC_LINK` (the macOS certificate) is never used for
Windows. Without them, installers are unsigned and
SmartScreen warns on first run. Cloud signing (e.g. Azure Trusted Signing) works too through
electron-builder's `win.azureSignOptions`.

**Runtime dependencies.** GitColumn uses the `git` on the user's PATH. Git LFS files need
[`git-lfs`](https://git-lfs.com) (`brew install git-lfs` / `winget install GitHub.GitLFS` /
`apt install git-lfs`, then `git lfs install`). Pull requests need the
[GitHub CLI](https://cli.github.com) signed in with `gh auth login`.

## Features

- **Working Copy** — sortable file table (flat or folder tree) with tri-state staging checkboxes,
  stage/unstage/discard whole files, **chunks or individual lines** (click or drag in the diff
  gutter, also with zero context lines), Staged/Unstaged toggle, context lines, wrap and whitespace
  options, syntax-highlighted diffs with word-level changes, side-by-side / onion-skin **image
  diffs**, Git LFS pointer detection, **Ignore…** (file, extension or folder; .gitignore or
  info/exclude).
- **Commit composer** — author with avatar, subject/body with length hint, sign-off, your
  `commit.template`, amend, Unstage All, ⌘↩ to commit.
- **History** — virtualized commit list with a lane graph (up to 48 lanes, scrollable sideways,
  resizable), month sections, compact two-line rows with avatars when narrow, branch/remote/tag
  badges, current branch or all branches, search by message, author or code (`-S`).
- **Commit details** — Changeset with expandable per-file diffs, or the commit's full file Tree.
- **Files** — browse the working copy or any branch, tag or commit with a fuzzy filter, preview,
  blame and history per file, export a revision (or a folder or file) as a zip.
- **Rewrite history** — interactive rebase editor (pick, reword, edit, squash, fixup, drop,
  drag to reorder) plus one-click *Edit Message*, *Squash/Fixup into Parent* and *Drop Commit* —
  also **across merge commits**, which are recreated (`--rebase-merges`) rather than flattened.
- **Branches Review** — every branch against a base: ahead/behind, merged, stale, gone upstream;
  bulk-delete merged branches. **Pinned** and **archived** branches, **stacked branches** with
  Restack, **worktrees**, and a **Compare** view (commits and files, two or three dots).
- **Pull Requests** — list, read (conversation, checks, files, commits), check out, create and merge
  GitHub pull requests through your own `gh` login.
- **Quick Actions** (⌘K / ⌘⇧A) — fuzzy search over commands, branches, files and commits.
- **Reflog** — every position HEAD (or a branch) has been at, to recover lost work.
- **File history & blame** — every commit that touched a file (following renames) with its diff;
  blame with syntax highlighting, age colouring and *Blame Previous Revision*.
- **Undo (⌘Z)** — staging, discards (including untracked files), commits, amends, checkouts,
  branch create/delete/rename, merges, rebases, cherry-picks, reverts, resets, stashes and tags.
  Success toasts carry an **Undo** button, and the undo history survives restarts.
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
| ⌘1 … ⌘7 | Working Copy, History, Stashes, Files, Pull Requests, Reflog, Branches Review |
| ⌘K / ⌘⇧A | Quick Actions |
| ⌘[ / ⌘] | Back / Forward (also the mouse's side buttons) |
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
shared/rebase.ts     which merges a rebase plan recreates (used by both sides)
server/git.ts        spawns git (no terminal prompts, timeouts, output caps, per-call env)
server/parse.ts      parsers: status v2, refs, log, diffs, blame, submodules, LFS…
server/patch.ts      builds partial patches for hunk / line staging
server/api.ts        core operations as named handlers, combined with the modules below
server/undo.ts       the persistent undo journal and its executors
server/files.ts      file trees, contents and zip export at any revision
server/branches.ts   branches review, flags, stacks, worktrees, comparisons
server/rebase.ts     interactive rebase across merges
server/github.ts     pull requests through the GitHub CLI
server/reflog.ts     the reflog
server/ignore.ts     Ignore… (.gitignore / info/exclude)
server/http.ts       exposes the handlers over HTTP for browser mode (dev only)
electron/            main process (IPC, menu, askpass bridge, trash) and preload bridge
src/                 React renderer: repo context + undo stack, actions, views, dialogs
scripts/             dev server, Electron bundling, icon generation, release wrapper, tests
build/               icon source (icon.svg) and generated platform icons
```

The renderer calls `window.gitcolumn.invoke(method, args)` in Electron and falls back to
`POST /api/<method>` in browser mode, so the same UI runs in both.

Undo works by snapshotting before an operation: the index is saved with `git write-tree`, working
tree files with `git hash-object -w`, and refs by hash. Each undo step is stored as data (not code)
in `.git/gitcolumn/undo.json` (per worktree, last 30 steps, 7 days). Undo restores exactly that
state and refuses if the repository moved on in the meantime; ref changes are applied in one
compare-and-swap transaction (`git update-ref --stdin`).

## Known limitations

- Git LFS management needs `git-lfs` installed; without it LFS files show as pointer files.
- Across merge commits, interactive rebase can't reorder commits, change the merges themselves, or
  squash/fixup a commit that starts a branch or directly follows a merge, and it refuses merges that
  contain changes of their own ("evil merges").
- Undoing a hard reset moves the branch back but can't bring back the uncommitted changes it
  discarded.
- Pull requests are GitHub-only (github.com, or a GitHub Enterprise host `gh` is signed in to) and need
  the GitHub CLI (`gh`) signed in to an account with access to the repository.
- Pushes and other remote changes (including merging a pull request) can't be undone.
- Windows and Linux installers build cleanly (cross-built on macOS) but have only been exercised on
  macOS so far.
