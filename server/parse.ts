import type {
  Blame,
  BlameCommit,
  ChangedFile,
  Commit,
  DiffLine,
  FileCommit,
  FileDiff,
  FileStatus,
  Hunk,
  LfsFile,
  Ref,
  Remote,
  Stash,
  StatusCode,
  Submodule,
} from '../shared/types.ts';

export const FS = '\x1f'; // field separator used in --format strings
export const RS = '\x1e'; // record separator used in --format strings

// ---------------------------------------------------------------------------
// git status --porcelain=v2 -z --branch --show-stash
// ---------------------------------------------------------------------------

export interface ParsedStatus {
  branch: string | null;
  head: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  stashCount: number;
  files: FileStatus[];
}

export function parseStatus(raw: string): ParsedStatus {
  const result: ParsedStatus = { branch: null, head: null, ahead: 0, behind: 0, stashCount: 0, files: [] };
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [, key, ...rest] = entry.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      } else if (key === 'stash') result.stashCount = Number(value) || 0;
      continue;
    }
    const kind = entry[0];
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = splitN(entry, ' ', 9);
      result.files.push(fileEntry(parts[1], parts[2], parts[8]));
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const parts = splitN(entry, ' ', 10);
      const f = fileEntry(parts[1], parts[2], parts[9]);
      f.origPath = entries[++i];
      result.files.push(f);
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = splitN(entry, ' ', 11);
      result.files.push({
        path: parts[10],
        index: 'U',
        worktree: 'U',
        conflicted: true,
        conflictType: parts[1],
        submodule: parts[2][0] === 'S',
      });
    } else if (kind === '?') {
      result.files.push({ path: entry.slice(2), index: '.', worktree: '?', untracked: true });
    }
  }
  return result;
}

function fileEntry(xy: string, sub: string, path: string): FileStatus {
  const f: FileStatus = { path, index: xy[0] as StatusCode, worktree: xy[1] as StatusCode };
  if (sub[0] === 'S') f.submodule = true;
  return f;
}

/** Split into at most n parts; the last part keeps any remaining separators (paths may contain spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = s.indexOf(sep, start);
    if (idx === -1) break;
    parts.push(s.slice(start, idx));
    start = idx + sep.length;
  }
  parts.push(s.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// git for-each-ref
// ---------------------------------------------------------------------------

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(creatordate:unix)',
  '%(symref)',
  '%(contents:subject)',
].join('%1f');

export function parseRefs(raw: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [refname, objectname, peeled, upstream, track, head, date, symref, subject] = line.split(FS);
    if (symref) continue; // e.g. refs/remotes/origin/HEAD
    let type: Ref['type'];
    let name: string;
    let remote: string | undefined;
    if (refname.startsWith('refs/heads/')) {
      type = 'head';
      name = refname.slice('refs/heads/'.length);
    } else if (refname.startsWith('refs/remotes/')) {
      type = 'remote';
      name = refname.slice('refs/remotes/'.length);
      remote = name.split('/')[0];
    } else if (refname.startsWith('refs/tags/')) {
      type = 'tag';
      name = refname.slice('refs/tags/'.length);
    } else continue;
    const ref: Ref = {
      type,
      ref: refname,
      name,
      remote,
      hash: peeled || objectname,
      date: Number(date) || 0,
      subject: subject ?? '',
    };
    if (upstream) ref.upstream = upstream;
    if (track) {
      if (track === 'gone') ref.upstreamGone = true;
      const a = /ahead (\d+)/.exec(track);
      const b = /behind (\d+)/.exec(track);
      if (a) ref.ahead = Number(a[1]);
      if (b) ref.behind = Number(b[1]);
    }
    if (head === '*') ref.current = true;
    refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%ct'].join('%x1f') + '%x1e';

export function parseLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of raw.split(RS)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const [hash, parents, author, email, date, subject, committed] = r.split(FS);
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      subject: subject ?? '',
      committerDate: committed ? Number(committed) : undefined,
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// git remote -v
// ---------------------------------------------------------------------------

export function parseRemotes(raw: string): Remote[] {
  const map = new Map<string, Remote>();
  for (const line of raw.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// git stash list --format=%gd%x1f%H%x1f%at%x1f%gs
// ---------------------------------------------------------------------------

export function parseStashes(raw: string): Stash[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      const [ref, hash, date, message] = line.split(FS);
      const m = /\{(\d+)\}/.exec(ref);
      return { index: m ? Number(m[1]) : i, ref, hash, date: Number(date), message: message ?? '' };
    });
}

// ---------------------------------------------------------------------------
// git diff --name-status -z / --numstat -z
// ---------------------------------------------------------------------------

export function parseNameStatus(raw: string): ChangedFile[] {
  const parts = raw.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = code[0] as StatusCode;
    if (status === 'R' || status === 'C') {
      const origPath = parts[++i];
      const path = parts[++i];
      files.push({ path, origPath, status });
    } else {
      files.push({ path: parts[++i], status });
    }
  }
  return files;
}

export function parseNumstat(raw: string): Map<string, { additions?: number; deletions?: number; binary?: boolean }> {
  const result = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      // rename: "add\tdel\t\0old\0new"
      i++;
      path = parts[++i];
    }
    const binary = m[1] === '-';
    result.set(path, binary ? { binary } : { additions: Number(m[1]), deletions: Number(m[2]) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(raw: string, maxLines = 20000): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHeader = false;
  let total = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = newFile(line);
      files.push(file);
      hunk = null;
      inHeader = true;
      continue;
    }
    if (!file) continue;

    if (inHeader) {
      if (line.startsWith('@@')) {
        inHeader = false;
      } else {
        file.header.push(line);
        if (line.startsWith('new file mode ')) {
          file.isNew = true;
          file.newMode = line.slice(14);
        } else if (line.startsWith('deleted file mode ')) {
          file.isDeleted = true;
          file.oldMode = line.slice(18);
        } else if (line.startsWith('old mode ')) file.oldMode = line.slice(9);
        else if (line.startsWith('new mode ')) file.newMode = line.slice(9);
        else if (line.startsWith('similarity index ')) file.similarity = parseInt(line.slice(17), 10);
        else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
          file.isRename = true;
          file.oldPath = line.replace(/^(rename|copy) from /, '');
        } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
          file.newPath = line.replace(/^(rename|copy) to /, '');
        } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.isBinary = true;
        else if (line.startsWith('--- ')) {
          const p = stripPrefix(line.slice(4));
          if (p !== null) file.oldPath = p;
        } else if (line.startsWith('+++ ')) {
          const p = stripPrefix(line.slice(4));
          if (p !== null) file.newPath = p;
        }
        continue;
      }
    }

    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (total >= maxLines) {
      file.truncated = true;
      continue;
    }

    const c = line[0];
    let dl: DiffLine | null = null;
    if (c === '+') {
      dl = { type: 'add', content: line.slice(1), newNo: newNo++ };
      file.additions++;
    } else if (c === '-') {
      dl = { type: 'del', content: line.slice(1), oldNo: oldNo++ };
      file.deletions++;
    } else if (c === ' ' || line === '') {
      dl = { type: 'context', content: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
    } else if (c === '\\') {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
    }
    if (dl) {
      hunk.lines.push(dl);
      total++;
    }
  }
  return files;
}

function newFile(line: string): FileDiff {
  // diff --git a/foo b/foo — ambiguous with spaces, refined later by ---/+++ or rename lines.
  const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(line);
  const oldPath = m ? m[1] : '';
  const newPath = m ? m[2] : '';
  return {
    oldPath,
    newPath,
    header: [line],
    isNew: false,
    isDeleted: false,
    isRename: false,
    isBinary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  p = p.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p.replace(/^[ab]\//, '');
}

// ---------------------------------------------------------------------------
// git log --follow --name-status (file history)
// ---------------------------------------------------------------------------

export const FILE_LOG_FORMAT = '%x1e' + ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');

export function parseFileLog(raw: string, requested: string): FileCommit[] {
  const commits: FileCommit[] = [];
  for (const rec of raw.split(RS)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const header = nl === -1 ? rec : rec.slice(0, nl);
    const rest = nl === -1 ? '' : rec.slice(nl + 1);
    const [hash, parents, author, email, date, subject] = header.split(FS);
    let path = requested;
    let oldPath: string | undefined;
    let status: StatusCode = 'M';
    const line = rest.split('\n').find((l) => /^[A-Z]\d*\t/.test(l));
    if (line) {
      const parts = line.split('\t');
      status = parts[0][0] as StatusCode;
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        oldPath = parts[1];
        path = parts[2];
      } else path = parts[1];
    }
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      subject: subject ?? '',
      path,
      oldPath,
      status,
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// git blame --porcelain
// ---------------------------------------------------------------------------

const BLAME_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/;

export function parseBlame(raw: string, path: string, rev: string | null): Blame {
  const commits: Record<string, BlameCommit> = {};
  const lines: Blame['lines'] = [];
  let current: { hash: string; orig: number; final: number } | null = null;
  for (const line of raw.split('\n')) {
    if (current && line.startsWith('\t')) {
      lines.push({ hash: current.hash, line: current.final, origLine: current.orig, content: line.slice(1) });
      current = null;
      continue;
    }
    const m = BLAME_HEADER.exec(line);
    if (m) {
      current = { hash: m[1], orig: Number(m[2]), final: Number(m[3]) };
      if (!commits[m[1]]) {
        commits[m[1]] = {
          hash: m[1],
          author: '',
          email: '',
          time: 0,
          summary: '',
          uncommitted: /^0+$/.test(m[1]),
        };
      }
      continue;
    }
    if (!current) continue;
    const c = commits[current.hash];
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'author') c.author = value;
    else if (key === 'author-mail') c.email = value.replace(/^<|>$/g, '');
    else if (key === 'author-time') c.time = Number(value);
    else if (key === 'summary') c.summary = value;
    else if (key === 'previous') {
      const i = value.indexOf(' ');
      c.previous = { hash: value.slice(0, i), path: value.slice(i + 1) };
    }
  }
  return { path, rev, commits, lines };
}

// ---------------------------------------------------------------------------
// Submodules: .gitmodules config + git submodule status
// ---------------------------------------------------------------------------

export function parseSubmodules(config: string, status: string): Submodule[] {
  const byName = new Map<string, Partial<Submodule>>();
  for (const line of config.split('\n')) {
    const m = /^submodule\.(.+)\.(path|url|branch) (.*)$/.exec(line);
    if (!m) continue;
    const entry = byName.get(m[1]) ?? { name: m[1] };
    entry[m[2] as 'path' | 'url' | 'branch'] = m[3];
    byName.set(m[1], entry);
  }
  const states = new Map<string, { hash: string; state: Submodule['state']; describe?: string }>();
  for (const line of status.split('\n')) {
    const m = /^([ +\-U])([0-9a-f]+) (.+?)(?: \((.*)\))?$/.exec(line);
    if (!m) continue;
    const state = m[1] === '-' ? 'uninitialized' : m[1] === '+' ? 'modified' : m[1] === 'U' ? 'conflict' : 'ok';
    states.set(m[3], { hash: m[2], state, describe: m[4] });
  }
  return [...byName.values()]
    .filter((e): e is Partial<Submodule> & { path: string } => !!e.path)
    .map((e) => {
      const st = states.get(e.path);
      return {
        name: e.name!,
        path: e.path,
        url: e.url ?? '',
        branch: e.branch,
        hash: st?.hash ?? '',
        state: st?.state ?? 'uninitialized',
        describe: st?.describe,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Git LFS
// ---------------------------------------------------------------------------

/** Patterns in a .gitattributes file that route through the LFS filter. */
export function parseLfsPatterns(gitattributes: string): string[] {
  return gitattributes
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /\sfilter=lfs(\s|$)/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

/** git lfs ls-files --long: "<oid> <*|-> <path>" */
export function parseLfsFiles(raw: string): LfsFile[] {
  return raw
    .split('\n')
    .map((l) => /^([0-9a-f]+) ([*-]) (.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ oid: m[1], downloaded: m[2] === '*', path: m[3] }));
}
