// Types shared between the git backend (Node) and the renderer (React).

export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface FileStatus {
  path: string;
  origPath?: string;
  /** Status in the index (staged side). '.' = unchanged */
  index: StatusCode;
  /** Status in the working tree (unstaged side). '.' = unchanged */
  worktree: StatusCode;
  untracked?: boolean;
  conflicted?: boolean;
  /** For conflicts: e.g. "UU", "AA", "DU" */
  conflictType?: string;
  submodule?: boolean;
}

export interface RepoState {
  merging: boolean;
  rebasing: boolean;
  cherryPicking: boolean;
  reverting: boolean;
  /** Pre-filled commit message for merges / cherry-picks */
  message?: string;
  /** For rebases: "3/7" */
  rebaseProgress?: string;
  rebaseHeadName?: string;
}

export interface Status {
  branch: string | null; // null when detached
  head: string | null; // commit sha, null for unborn branch
  upstream?: string;
  ahead: number;
  behind: number;
  files: FileStatus[];
  state: RepoState;
  stashCount: number;
}

export type RefType = 'head' | 'remote' | 'tag';

export interface Ref {
  type: RefType;
  /** Full refname, e.g. refs/heads/main */
  ref: string;
  /** Short name, e.g. main, origin/main, v1.0 */
  name: string;
  /** For remote refs: remote name (origin) */
  remote?: string;
  /** Commit the ref points to (peeled for annotated tags) */
  hash: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  current?: boolean;
  date: number;
  subject: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number; // unix seconds (author date)
  subject: string;
}

export interface CommitDetail extends Commit {
  committer: string;
  committerEmail: string;
  committerDate: number;
  body: string;
  files: ChangedFile[];
}

export interface ChangedFile {
  path: string;
  origPath?: string;
  status: StatusCode;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface Stash {
  index: number;
  ref: string; // stash@{0}
  hash: string;
  date: number;
  message: string;
}

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNo?: number;
  newNo?: number;
  /** "\ No newline at end of file" follows this line */
  noNewline?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** Raw header lines from "diff --git" through "+++", used to rebuild patches */
  header: string[];
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** Set when the diff was too large and lines were dropped */
  truncated?: boolean;
}

export type PatchAction = 'stage' | 'unstage' | 'discard';

/** hunk index -> selected line indexes within that hunk, or 'all' */
export type LineSelection = Record<number, number[] | 'all'>;

export interface RepoInfo {
  path: string;
  name: string;
}

export interface AppInfo {
  platform: string;
  home: string;
  gitVersion: string;
  electron: boolean;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
