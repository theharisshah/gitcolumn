import type {
  ApiResult,
  AppInfo,
  Blame,
  Blob,
  BlobSpec,
  Commit,
  CommitDetail,
  ChangedFile,
  FileCommit,
  FileContentResult,
  FileDiff,
  FileStatus,
  LfsFile,
  LfsStatus,
  LineSelection,
  PatchAction,
  RebasePlan,
  ReflogEntry,
  RebaseStep,
  Ref,
  Remote,
  RepoInfo,
  Snapshot,
  Stash,
  Status,
  Submodule,
  TreeEntry,
} from '../../shared/types';

declare global {
  interface Window {
    gitcolumn?: {
      platform: string;
      invoke(method: string, args: unknown): Promise<ApiResult>;
      onAskpass(cb: (req: { id: number; prompt: string }) => void): () => void;
      replyAskpass(id: number, value: string | null): void;
      onMenu(cb: (command: string) => void): () => void;
    };
  }
}

export const isElectron = !!window.gitcolumn;

export async function call<T = void>(method: string, args: object = {}): Promise<T> {
  let result: ApiResult;
  if (window.gitcolumn) {
    result = await window.gitcolumn.invoke(method, args);
  } else {
    const res = await fetch(`/api/${encodeURIComponent(method)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitColumn': '1' },
      body: JSON.stringify(args),
    });
    result = await res.json();
  }
  if (!result.ok) throw new Error(result.error || `${method} failed`);
  return result.data as T;
}

export interface ConflictResult {
  conflicts: boolean;
  message?: string;
}

export interface FileContent {
  content: string;
  binary: boolean;
  size: number;
  truncated: boolean;
}

export type SearchMode = 'message' | 'author' | 'content';

/** Typed wrappers around the backend methods. */
export const api = {
  appInfo: () => call<AppInfo>('app.info'),
  pickDirectory: (title?: string) => call<string | null>('dialog.pickDirectory', { title }),

  openRepo: (path: string) => call<RepoInfo>('repo.open', { path }),
  initRepo: (path: string) => call<RepoInfo>('repo.init', { path }),
  cloneRepo: (url: string, path: string) => call<RepoInfo>('repo.clone', { url, path }),

  status: (repo: string) => call<Status>('status', { repo }),
  refs: (repo: string) => call<Ref[]>('refs', { repo }),
  remotes: (repo: string) => call<Remote[]>('remotes', { repo }),
  log: (
    repo: string,
    opts: { ref?: string; all?: boolean; skip?: number; limit?: number; search?: string; searchMode?: SearchMode; path?: string },
  ) => call<Commit[]>('log', { repo, ...opts }),
  commitDetail: (repo: string, hash: string) => call<CommitDetail>('commit.detail', { repo, hash }),
  commitDiff: (repo: string, hash: string, parent?: string, paths?: string[]) =>
    call<FileDiff[]>('commit.diff', { repo, hash, parent, paths }),
  fileHistory: (repo: string, path: string, skip = 0, rev?: string | null) => call<FileCommit[]>('file.history', { repo, path, skip, rev }),
  treeList: (repo: string, rev: string | null, dir = '') => call<TreeEntry[]>('tree.list', { repo, rev, dir }),
  filesSearch: (repo: string, rev: string | null) => call<string[]>('files.search', { repo, rev }),
  fileContent: (repo: string, rev: string | null, path: string) => call<FileContentResult>('file.content', { repo, rev, path }),
  exportArchive: (repo: string, rev: string, name: string, path?: string) => call<string | null>('archive.export', { repo, rev, name, path }),
  revealExport: (path: string) => call('archive.reveal', { path }),
  diffFiles: (repo: string, from: string | null, to: string) => call<ChangedFile[]>('diff.files', { repo, from, to }),
  reflog: (repo: string, ref = 'HEAD', skip = 0, limit = 200) =>
    call<{ entries: ReflogEntry[]; hasMore: boolean }>('reflog.list', { repo, ref, skip, limit }),
  blame: (repo: string, path: string, rev?: string | null) => call<Blame>('blame', { repo, path, rev }),
  blob: (repo: string, spec: BlobSpec) => call<Blob | null>('file.blob', { repo, ...spec }),
  writeGitignore: (repo: string, content: string) => call('gitignore.write', { repo, content }),
  lastCommitMessage: (repo: string) => call<string>('commit.lastMessage', { repo }),
  workingDiff: (repo: string, file: FileStatus, staged: boolean, opts: { ignoreWhitespace?: boolean; context?: number } = {}) =>
    call<FileDiff | null>('diff.working', { repo, file, staged, ...opts }),
  readFile: (repo: string, path: string) => call<FileContent>('file.read', { repo, path }),

  stage: (repo: string, paths: string[]) => call('stage', { repo, paths }),
  stageAll: (repo: string) => call('stageAll', { repo }),
  unstage: (repo: string, paths: string[]) => call('unstage', { repo, paths }),
  unstageAll: (repo: string) => call('unstageAll', { repo }),
  discard: (repo: string, files: FileStatus[]) => call('discard', { repo, files }),
  applyPatch: (repo: string, diff: FileDiff, selection: LineSelection, action: PatchAction) =>
    call('patch.apply', { repo, diff, selection, action }),
  resolveConflict: (repo: string, path: string, side: 'ours' | 'theirs', conflictType?: string) =>
    call('conflict.resolve', { repo, path, side, conflictType }),

  commit: (repo: string, message: string, amend?: boolean) => call('commit', { repo, message, amend }),
  checkout: (repo: string, branch: string) => call('checkout', { repo, branch }),
  checkoutDetached: (repo: string, ref: string) => call('checkout.detached', { repo, ref }),
  checkoutRemote: (repo: string, remoteBranch: string, localName: string) =>
    call('checkout.remote', { repo, remoteBranch, localName }),
  createBranch: (repo: string, name: string, start?: string, checkout?: boolean) =>
    call('branch.create', { repo, name, start, checkout }),
  deleteBranch: (repo: string, name: string, force?: boolean) => call('branch.delete', { repo, name, force }),
  renameBranch: (repo: string, oldName: string, newName: string) => call('branch.rename', { repo, oldName, newName }),
  deleteRemoteBranch: (repo: string, remote: string, name: string) => call('branch.deleteRemote', { repo, remote, name }),
  setUpstream: (repo: string, branch: string, upstream: string | null) => call('branch.setUpstream', { repo, branch, upstream }),
  merge: (repo: string, ref: string, opts: { noFF?: boolean; squash?: boolean } = {}) =>
    call<ConflictResult>('merge', { repo, ref, ...opts }),
  rebase: (repo: string, onto: string) => call<ConflictResult>('rebase', { repo, onto }),
  cherryPick: (repo: string, hash: string) => call<ConflictResult>('cherryPick', { repo, hash }),
  revert: (repo: string, hash: string, parent?: number) => call<ConflictResult>('revert', { repo, hash, parent }),
  reset: (repo: string, hash: string, mode: 'soft' | 'mixed' | 'hard' | 'keep') => call('reset', { repo, hash, mode }),
  rebasePlan: (repo: string, base: string | null) => call<RebasePlan>('rebase.plan', { repo, base }),
  rebaseInteractive: (repo: string, base: string | null, steps: RebaseStep[]) =>
    call<ConflictResult & { paused: boolean }>('rebase.interactive', { repo, base, steps }),
  snapshot: (repo: string, paths?: string[]) => call<Snapshot>('snapshot.capture', { repo, paths }),
  restoreSnapshot: (repo: string, snapshot: Snapshot, index = true) => call('snapshot.restore', { repo, snapshot, index }),
  revParse: (repo: string, rev: string) => call<string | null>('rev.parse', { repo, rev }),
  updateRef: (repo: string, ref: string, hash: string) => call('ref.update', { repo, ref, hash }),
  deleteRef: (repo: string, ref: string) => call('ref.delete', { repo, ref }),
  stashStore: (repo: string, hash: string, message: string) => call('stash.store', { repo, hash, message }),
  submodules: (repo: string) => call<Submodule[]>('submodules', { repo }),
  updateSubmodule: (repo: string, path?: string) => call('submodule.update', { repo, path }),
  addSubmodule: (repo: string, url: string, path: string) => call('submodule.add', { repo, url, path }),
  syncSubmodules: (repo: string) => call('submodule.sync', { repo }),
  lfsStatus: (repo: string) => call<LfsStatus>('lfs.status', { repo }),
  lfsFiles: (repo: string) => call<LfsFile[]>('lfs.files', { repo }),
  lfsInstall: (repo: string) => call('lfs.install', { repo }),
  lfsTrack: (repo: string, pattern: string) => call('lfs.track', { repo, pattern }),
  lfsUntrack: (repo: string, pattern: string) => call('lfs.untrack', { repo, pattern }),
  lfsPull: (repo: string) => call('lfs.pull', { repo }),
  setRemoteUrl: (repo: string, name: string, url: string) => call('remote.setUrl', { repo, name, url }),
  continueOp: (repo: string) => call<ConflictResult>('op.continue', { repo }),
  abortOp: (repo: string) => call('op.abort', { repo }),
  skipOp: (repo: string) => call<ConflictResult>('op.skip', { repo }),

  fetch: (repo: string, remote?: string, quiet?: boolean) => call('fetch', { repo, remote, quiet }),
  pull: (repo: string, rebase?: boolean) => call<ConflictResult>('pull', { repo, rebase }),
  push: (repo: string, branch: string, opts: { remote?: string; force?: boolean; setUpstream?: boolean } = {}) =>
    call<{ remote: string }>('push', { repo, branch, ...opts }),
  addRemote: (repo: string, name: string, url: string) => call('remote.add', { repo, name, url }),
  removeRemote: (repo: string, name: string) => call('remote.remove', { repo, name }),

  stashes: (repo: string) => call<Stash[]>('stash.list', { repo }),
  stashSave: (repo: string, opts: { message?: string; includeUntracked?: boolean; keepIndex?: boolean }) =>
    call('stash.save', { repo, ...opts }),
  stashApply: (repo: string, ref: string, pop?: boolean) => call<ConflictResult>('stash.apply', { repo, ref, pop }),
  stashDrop: (repo: string, ref: string) => call('stash.drop', { repo, ref }),
  stashDiff: (repo: string, ref: string) => call<FileDiff[]>('stash.diff', { repo, ref }),

  createTag: (repo: string, name: string, target?: string, message?: string) =>
    call('tag.create', { repo, name, target, message }),
  deleteTag: (repo: string, name: string) => call('tag.delete', { repo, name }),
  pushTag: (repo: string, name: string, remote?: string) => call('tag.push', { repo, name, remote }),
  deleteRemoteTag: (repo: string, name: string, remote: string) => call('tag.deleteRemote', { repo, name, remote }),

  identity: (repo: string) => call<{ name: string; email: string }>('config.identity', { repo }),
  setIdentity: (repo: string, name: string, email: string, global?: boolean) =>
    call('config.setIdentity', { repo, name, email, global }),

  reveal: (repo: string, path?: string) => call('shell.reveal', { repo, path }),
  openPath: (repo: string, path?: string) => call('shell.open', { repo, path }),
  openTerminal: (repo: string) => call('shell.terminal', { repo }),
};
