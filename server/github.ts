// Pull requests through the GitHub CLI (gh), using the user's own gh login.
import type {
  FileDiff,
  GhCheck,
  GhChecks,
  GhConversationItem,
  GhMergeMethod,
  GhPullDetail,
  GhPullSummary,
  GhRepo,
  GhStatus,
  GhUser,
} from '../shared/types.ts';
import type { HandlerModule } from './ctx.ts';
import { git, gitEnv } from './git.ts';
import { parseDiff } from './parse.ts';
import { assertSafe, execCapture, NETWORK_TIMEOUT } from './util.ts';

export class GhError extends Error {
  constructor(
    readonly kind: 'not-installed' | 'not-authenticated' | 'not-github' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** owner/name (and host) from any remote URL form: scp-like, ssh:// and https://. */
export function parseGitHubRemote(url: string): { host: string; owner: string; name: string } | null {
  const u = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  const full = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u);
  if (full) [, host, path] = full;
  else if (scp) [, host, path] = scp;
  else return null;
  const parts = path.replace(/\.git\/?$/, '').replace(/\/+$/, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { host: host.toLowerCase(), owner: parts[0], name: parts[1] };
}

type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
};

/** Checks come as GitHub Actions check runs or as legacy commit statuses; give both one shape. */
export function normalizeChecks(rollup: RawCheck[] | null | undefined): { runs: GhCheck[]; summary: GhChecks } {
  const runs: GhCheck[] = (rollup ?? []).map((c) => {
    let state: GhCheck['state'];
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      const s = (c.state ?? '').toUpperCase();
      state = s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'ERROR' ? 'failure' : 'pending';
    } else if ((c.status ?? '').toUpperCase() !== 'COMPLETED') {
      state = 'pending';
    } else {
      const k = (c.conclusion ?? '').toUpperCase();
      state =
        k === 'SUCCESS' ? 'success' : k === 'NEUTRAL' ? 'neutral' : k === 'SKIPPED' ? 'skipped' : k === '' ? 'pending' : 'failure'; // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
    }
    return { name: c.name ?? c.context ?? 'check', state, url: c.detailsUrl ?? c.targetUrl, workflow: c.workflowName || undefined };
  });
  const passed = runs.filter((r) => r.state === 'success' || r.state === 'neutral' || r.state === 'skipped').length;
  const failed = runs.filter((r) => r.state === 'failure').length;
  const pending = runs.filter((r) => r.state === 'pending').length;
  const state: GhChecks['state'] = !runs.length ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success';
  return { runs, summary: { state, total: runs.length, passed, failed, pending } };
}

type RawUser = { login?: string; name?: string; is_bot?: boolean };
const user = (u: RawUser | null | undefined): GhUser => ({ login: u?.login ?? 'ghost', ...(u?.name ? { name: u.name } : {}), ...(u?.is_bot ? { bot: true } : {}) });

const SUMMARY_FIELDS = 'number,title,state,author,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,createdAt,updatedAt,url,labels,isCrossRepository';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizePull(raw: any): GhPullSummary {
  const state = String(raw.state ?? '').toUpperCase();
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    author: user(raw.author),
    headRefName: String(raw.headRefName ?? ''),
    baseRefName: String(raw.baseRefName ?? ''),
    isDraft: !!raw.isDraft,
    reviewDecision: raw.reviewDecision || null,
    checks: normalizeChecks(raw.statusCheckRollup).summary,
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    url: String(raw.url ?? ''),
    labels: (raw.labels ?? []).map((l: { name: string; color?: string }) => ({ name: l.name, color: l.color ?? '888888' })),
    isCrossRepository: !!raw.isCrossRepository,
  };
}

export const githubApi: HandlerModule = () => {
  const statusCache = new Map<string, { at: number; value: GhStatus }>();
  const avatarCache = new Map<string, { at: number; value: Record<string, string> }>();
  const ghBinary = () => process.env.GITCOLUMN_GH || 'gh';

  async function gh(repo: string, args: string[], opts: { input?: string; timeout?: number } = {}): Promise<string> {
    const env = {
      ...gitEnv(),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      GH_PAGER: 'cat',
      NO_COLOR: '1',
      CLICOLOR: '0',
    };
    const r = await execCapture(ghBinary(), args, { cwd: repo, env, input: opts.input, timeout: opts.timeout ?? NETWORK_TIMEOUT });
    if (r.error?.code === 'ENOENT') throw new GhError('not-installed', 'The GitHub CLI (gh) is not installed.');
    if (r.error) throw new GhError('failed', r.error.message);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (r.code === 4 || /gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(msg)) throw new GhError('not-authenticated', msg);
      throw new GhError('failed', msg || `gh exited with code ${r.code}`);
    }
    return r.stdout;
  }

  /** The GitHub repository behind this clone: origin, else the first remote that is on a GitHub host. */
  async function remoteRepo(repo: string): Promise<{ remote: string; host: string; owner: string; name: string }> {
    const out = await git(repo, ['remote', '-v']).catch(() => '');
    const remotes: { remote: string; url: string }[] = [];
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
      if (m) remotes.push({ remote: m[1], url: m[2] });
    }
    const ordered = [...remotes.filter((r) => r.remote === 'origin'), ...remotes.filter((r) => r.remote !== 'origin')];
    for (const r of ordered) {
      const parsed = parseGitHubRemote(r.url);
      if (parsed) return { remote: r.remote, ...parsed, host: await resolveSshHost(parsed.host, r.url) };
    }
    throw new GhError('not-github', remotes.length ? 'None of this repository’s remotes is on GitHub.' : 'This repository has no remotes.');
  }

  /** SSH remotes may use a host alias from ~/.ssh/config (e.g. "github-work" for a second account). */
  const sshHosts = new Map<string, string>();
  async function resolveSshHost(host: string, url: string): Promise<string> {
    if (/^(https?|git):\/\//.test(url) || host === 'github.com') return host;
    if (!sshHosts.has(host)) {
      const r = await execCapture('ssh', ['-G', '--', host], { timeout: 5000 });
      const m = /^hostname\s+(\S+)$/m.exec(r.stdout);
      sshHosts.set(host, m ? m[1].toLowerCase() : host);
    }
    return sshHosts.get(host)!;
  }

  async function status(repo: string, refresh = false): Promise<GhStatus> {
    const cached = statusCache.get(repo);
    if (cached && !refresh && Date.now() - cached.at < 60_000) return cached.value;
    let value: GhStatus;
    try {
      const where = await remoteRepo(repo);
      await gh(repo, ['--version'], { timeout: 15_000 });
      const userOut = await gh(repo, ['api', '--hostname', where.host, 'user', '--jq', '.login'], { timeout: 30_000 }).catch((e) => {
        if (e instanceof GhError && e.kind === 'failed' && /HTTP 404|Not Found/.test(e.message)) throw new GhError('not-github', `${where.host} isn’t a GitHub host gh knows.`);
        throw e;
      });
      const view = async (nameWithOwner: string) =>
        JSON.parse(
          await gh(repo, [
            'repo',
            'view',
            `${where.host}/${nameWithOwner}`,
            '--json',
            'nameWithOwner,url,defaultBranchRef,isFork,parent,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission',
          ]).catch((e) => {
            // GitHub answers "not found" for private repositories the signed-in account can't see.
            if (e instanceof GhError && /Could not resolve to a Repository|HTTP 404/i.test(e.message)) {
              throw new GhError(
                'not-authenticated',
                `The account gh is signed in with (${userOut.trim() || 'unknown'}) can't see ${nameWithOwner}. Switch accounts with “gh auth switch”, or sign in with one that has access.`,
              );
            }
            throw e;
          }),
        );
      const own = await view(`${where.owner}/${where.name}`);
      const parent = own.isFork && own.parent?.owner?.login && own.parent?.name ? `${own.parent.owner.login}/${own.parent.name}` : undefined;
      // Pull requests from a fork go to its parent: merge settings and permissions come from there.
      const raw = parent ? await view(parent).catch(() => own) : own;
      const methods: GhMergeMethod[] = [];
      if (raw.mergeCommitAllowed) methods.push('merge');
      if (raw.squashMergeAllowed) methods.push('squash');
      if (raw.rebaseMergeAllowed) methods.push('rebase');
      const repoInfo: GhRepo = {
        nameWithOwner: raw.nameWithOwner,
        url: raw.url,
        defaultBranch: raw.defaultBranchRef?.name ?? 'main',
        isFork: !!own.isFork,
        ...(parent ? { parent } : {}),
        mergeMethods: methods.length ? methods : ['merge'],
        canMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(String(raw.viewerPermission ?? '').toUpperCase()),
        remote: where.remote,
      };
      value = { state: 'ready', host: where.host, repo: repoInfo, user: userOut.trim() || null };
    } catch (e) {
      if (e instanceof GhError) {
        if (e.kind === 'not-installed') value = { state: 'not-installed' };
        else if (e.kind === 'not-authenticated') value = { state: 'not-authenticated', host: (await remoteRepo(repo).catch(() => null))?.host ?? 'github.com', message: e.message };
        else if (e.kind === 'not-github') value = { state: 'not-github', message: e.message };
        else value = { state: 'error', message: e.message };
      } else value = { state: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    statusCache.set(repo, { at: Date.now(), value });
    return value;
  }

  async function ready(repo: string): Promise<{ target: string; status: Extract<GhStatus, { state: 'ready' }> }> {
    const s = await status(repo);
    if (s.state !== 'ready') {
      const msg = s.state === 'not-installed' ? 'The GitHub CLI (gh) is not installed.' : s.message;
      throw new GhError(s.state === 'not-installed' ? 'not-installed' : s.state === 'not-authenticated' ? 'not-authenticated' : 'failed', msg);
    }
    return { target: `${s.host}/${s.repo.nameWithOwner}`, status: s };
  }

  const num = (n: unknown) => {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) throw new Error('Invalid pull request number');
    return String(v);
  };

  return {
    async 'gh.status'({ repo, refresh }: { repo: string; refresh?: boolean }): Promise<GhStatus> {
      return status(repo, refresh);
    },

    async 'gh.prList'({ repo, state = 'open', search, limit = 50 }: { repo: string; state?: 'open' | 'closed' | 'merged'; search?: string; limit?: number }): Promise<GhPullSummary[]> {
      const { target } = await ready(repo);
      if (!['open', 'closed', 'merged'].includes(state)) throw new Error('Invalid state');
      const args = ['pr', 'list', '-R', target, '--state', state, '--limit', String(Math.min(Math.max(1, limit), 200)), '--json', SUMMARY_FIELDS];
      if (search?.trim()) args.push('--search', search.trim());
      return (JSON.parse(await gh(repo, args)) as unknown[]).map(normalizePull);
    },

    async 'gh.prView'({ repo, number }: { repo: string; number: number }): Promise<GhPullDetail> {
      const { target } = await ready(repo);
      const raw = JSON.parse(
        await gh(repo, [
          'pr',
          'view',
          num(number),
          '-R',
          target,
          '--json',
          `${SUMMARY_FIELDS},body,headRefOid,baseRefOid,mergeable,mergeStateStatus,additions,deletions,changedFiles,mergedAt,closedAt,comments,reviews,commits,files`,
        ]),
      );
      const conversation: GhConversationItem[] = [
        ...(raw.comments ?? []).map((c: { author?: RawUser; body?: string; createdAt?: string }) => ({
          kind: 'comment' as const,
          author: c.author?.login ?? 'ghost',
          body: c.body ?? '',
          createdAt: c.createdAt ?? '',
        })),
        ...(raw.reviews ?? []).map((r: { author?: RawUser; body?: string; submittedAt?: string; state?: string }) => ({
          kind: 'review' as const,
          author: r.author?.login ?? 'ghost',
          body: r.body ?? '',
          createdAt: r.submittedAt ?? '',
          reviewState: r.state,
        })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        ...normalizePull(raw),
        body: raw.body ?? '',
        headRefOid: raw.headRefOid ?? '',
        baseRefOid: raw.baseRefOid ?? '',
        mergeable: raw.mergeable ?? 'UNKNOWN',
        mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
        additions: raw.additions ?? 0,
        deletions: raw.deletions ?? 0,
        changedFiles: raw.changedFiles ?? 0,
        mergedAt: raw.mergedAt ?? null,
        closedAt: raw.closedAt ?? null,
        conversation,
        checkRuns: normalizeChecks(raw.statusCheckRollup).runs,
        commits: (raw.commits ?? []).map((c: { oid: string; messageHeadline?: string; authoredDate?: string; authors?: { name?: string; login?: string }[] }) => ({
          oid: c.oid,
          headline: c.messageHeadline ?? '',
          date: c.authoredDate ?? '',
          authors: (c.authors ?? []).map((a) => a.login || a.name || ''),
        })),
        files: (raw.files ?? []).map((f: { path: string; additions?: number; deletions?: number }) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
      };
    },

    /** The pull request's diff from GitHub; falls back to fetching its head and diffing locally. */
    async 'gh.prDiff'({ repo, number }: { repo: string; number: number }): Promise<FileDiff[]> {
      const { target, status: s } = await ready(repo);
      try {
        return parseDiff(await gh(repo, ['pr', 'diff', num(number), '-R', target, '--color', 'never']));
      } catch (e) {
        // GitHub refuses diffs that are too large; build it locally from refs/pull/N/head instead.
        if (!(e instanceof GhError) || e.kind !== 'failed') throw e;
        const view = JSON.parse(await gh(repo, ['pr', 'view', num(number), '-R', target, '--json', 'headRefOid,baseRefName']));
        await git(repo, ['fetch', '--no-tags', s.repo.remote, `refs/pull/${num(number)}/head`], { timeout: NETWORK_TIMEOUT });
        const base = (await git(repo, ['merge-base', 'FETCH_HEAD', `refs/remotes/${s.repo.remote}/${view.baseRefName}`])).trim();
        return parseDiff(await git(repo, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', base, 'FETCH_HEAD'], { maxBytes: 30 * 1024 * 1024 }));
      }
    },

    async 'gh.prCheckout'({ repo, number }: { repo: string; number: number }) {
      const { target } = await ready(repo);
      // Never --force: an existing local branch that has diverged must not be overwritten.
      await gh(repo, ['pr', 'checkout', num(number), '-R', target]);
    },

    async 'gh.prCreate'({
      repo,
      title,
      body,
      base,
      head,
      draft,
    }: {
      repo: string;
      title: string;
      body: string;
      base: string;
      head: string;
      draft?: boolean;
    }): Promise<{ number: number | null; url: string }> {
      const { target, status: s } = await ready(repo);
      if (!title?.trim()) throw new Error('A pull request needs a title.');
      assertSafe(base);
      assertSafe(head);
      // From a fork, the head branch lives in the fork: owner:branch.
      const where = await remoteRepo(repo);
      const headArg = s.repo.isFork && !head.includes(':') ? `${where.owner}:${head}` : head;
      const args = ['pr', 'create', '-R', target, '--title', title.trim(), '--body-file', '-', '--base', base, '--head', headArg];
      if (draft) args.push('--draft');
      const out = await gh(repo, args, { input: body ?? '' });
      const url = out.trim().split('\n').reverse().find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? out.trim();
      const m = /\/pull\/(\d+)/.exec(url);
      statusCache.delete(repo);
      return { number: m ? Number(m[1]) : null, url };
    },

    /** Merge on GitHub, only if the head is still the commit the user saw. Never deletes local branches (-d). */
    async 'gh.prMerge'({ repo, number, method, headOid }: { repo: string; number: number; method: GhMergeMethod; headOid: string }) {
      const { target } = await ready(repo);
      if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('Invalid merge method');
      if (!/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error('Invalid head commit');
      await gh(repo, ['pr', 'merge', num(number), '-R', target, `--${method}`, '--match-head-commit', headOid]);
    },

    /** Avatar URLs of recent authors (by email), from the default branch's history on GitHub. Cached for a day. */
    async 'gh.avatars'({ repo }: { repo: string }): Promise<Record<string, string>> {
      const cached = avatarCache.get(repo);
      if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.value;
      const s = await status(repo);
      if (s.state !== 'ready') return {};
      const [owner, name] = s.repo.nameWithOwner.split('/');
      const query =
        'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{target{... on Commit{history(first:100){nodes{author{email avatarUrl(size:64)}}}}}}}}';
      const value: Record<string, string> = {};
      try {
        const out = JSON.parse(await gh(repo, ['api', 'graphql', '--hostname', s.host, '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`]));
        for (const n of out?.data?.repository?.defaultBranchRef?.target?.history?.nodes ?? []) {
          const email = n?.author?.email;
          const url = n?.author?.avatarUrl;
          if (email && typeof url === 'string' && url.startsWith('https://avatars.githubusercontent.com/')) value[String(email).toLowerCase()] = url;
        }
      } catch {
        /* avatars are a nicety */
      }
      avatarCache.set(repo, { at: Date.now(), value });
      return value;
    },
  };
};
