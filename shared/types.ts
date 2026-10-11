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
  /** Tree object of the commit */
  tree: string;
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
  /** The shared .git directory (differs from the worktree's own git dir for linked worktrees) */
  commonDir?: string;
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

// ------------------------------------------------------------ file history

export interface FileCommit extends Commit {
  /** Path of the file in this commit (differs from the requested path after renames) */
  path: string;
  /** Previous path when this commit renamed the file */
  oldPath?: string;
  status: StatusCode;
}

export interface BlameCommit {
  hash: string;
  author: string;
  email: string;
  time: number;
  summary: string;
  /** Commit and path to continue blaming from ("blame previous revision") */
  previous?: { hash: string; path: string };
  uncommitted: boolean;
}

export interface BlameLine {
  hash: string;
  line: number;
  origLine: number;
  content: string;
}

export interface Blame {
  path: string;
  rev: string | null;
  commits: Record<string, BlameCommit>;
  lines: BlameLine[];
}

/** Where to read a file version from: a revision (`HEAD`, `<sha>`), ':' for the index, or null for the working tree. */
export interface BlobSpec {
  revs: (string | null)[];
  path: string;
}

export interface Blob {
  dataUrl: string;
  size: number;
}

// -------------------------------------------------------------- submodules

export interface Submodule {
  name: string;
  path: string;
  url: string;
  branch?: string;
  hash: string;
  /** ok | uninitialized | modified (checked-out commit differs from the recorded one) | conflict */
  state: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe?: string;
}

// --------------------------------------------------------------------- LFS

export interface LfsStatus {
  installed: boolean;
  version?: string;
  /** Patterns from .gitattributes that use filter=lfs */
  patterns: string[];
}

export interface LfsFile {
  oid: string;
  path: string;
  /** Object content is present locally (vs. pointer only) */
  downloaded: boolean;
}

// --------------------------------------------------------- interactive rebase

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseStep {
  action: RebaseAction;
  hash: string;
  /** New message for 'reword' */
  message?: string;
}

export interface RebasePlanCommit extends Commit {
  body: string;
  pushed: boolean;
}

export interface RebasePlan {
  base: string | null;
  commits: RebasePlanCommit[];
  hasMerges: boolean;
}

// -------------------------------------------------------------------- undo

export interface FileSnapshot {
  path: string;
  /** Blob with the file's working tree content, or null if the file did not exist */
  blob: string | null;
  /** Permission bits to restore */
  mode?: number;
}

export interface Snapshot {
  head: string | null;
  branch: string | null;
  /** Tree object of the index, or null when the index has conflicts */
  index: string | null;
  files?: FileSnapshot[];
}

// ------------------------------------------------------------------- files

export interface TreeEntry {
  name: string;
  /** Path from the repository root, '/'-separated */
  path: string;
  /** commit = submodule (gitlink) */
  type: 'blob' | 'tree' | 'commit' | 'symlink';
  mode?: string;
  oid?: string;
  size?: number;
}

export interface FileContentResult {
  kind: 'text' | 'binary' | 'image' | 'lfs' | 'symlink' | 'submodule' | 'missing';
  /** Text content (text, lfs pointer, symlink target) */
  content: string;
  size: number;
  truncated: boolean;
  oid?: string;
  submodule?: { commit: string; url?: string };
}

// ------------------------------------------------------------------ reflog

export interface ReflogEntry {
  /** Position in the reflog (0 = most recent) */
  index: number;
  /** e.g. HEAD@{3}, main@{0} */
  selector: string;
  hash: string;
  parents: string[];
  /** Where the ref pointed before this entry (the next older entry), if known */
  previous?: string;
  /** e.g. "commit", "commit (amend)", "checkout", "rebase (finish)", "reset" */
  action: string;
  detail: string;
  /** When the ref moved (unix seconds) */
  time: number;
  identity: { name: string; email: string };
  authorDate: number;
  subject: string;
}

// ----------------------------------------------------- undo (persisted)

export interface HeadPos {
  head: string | null;
  branch: string | null;
}

/** A serializable description of how to undo an operation; validated and executed by the backend. */
export type UndoSpec =
  | { kind: 'head-reset'; from: string; to: string; mode: 'keep' | 'soft'; index?: string | null; branch: string | null }
  | { kind: 'commit'; from: string; to: string | null; branch: string | null; message: string }
  | { kind: 'index'; tree: string; head: string | null }
  | { kind: 'files'; snapshot: Snapshot }
  | { kind: 'refs'; updates: { ref: string; old: string | null; new: string | null }[]; config?: [string, string | null][] }
  | { kind: 'checkout'; from: HeadPos; to: HeadPos; deleteBranch?: { name: string; hash: string } }
  | { kind: 'branch-rename'; from: string; to: string; hash: string }
  /** Previous raw branch.<name>.remote / .merge values (null = unset) */
  | { kind: 'upstream'; branch: string; config: [string, string | null][] }
  | { kind: 'stash-save'; hash: string }
  | { kind: 'stash-apply'; snapshot: Snapshot; restore?: { hash: string; message: string } }
  | { kind: 'stash-drop'; hash: string; message: string }
  | { kind: 'remote-add'; name: string }
  /**
   * Every remote.<name>.* value plus the branch.*.remote/merge/pushRemote and remote.pushDefault values
   * that pointed at it, and its remote-tracking refs (restored when their objects still exist).
   */
  | { kind: 'remote-remove'; name: string; config: [string, string][]; refs?: [string, string][] };

export interface UndoState {
  count: number;
  top: { id: string; label: string; createdAt: number } | null;
}

export interface UndoResult {
  label: string;
  /** The undo ran but left conflicts to resolve (e.g. re-applying a stash) */
  conflicts?: boolean;
  /** Something the user should know, e.g. a part that was left as it is */
  note?: string;
  /** For undone commits: the message to put back into the composer */
  restoreMessage?: string;
}
