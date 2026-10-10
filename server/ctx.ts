import type { RepoState, Status } from '../shared/types.ts';
import type { ConflictResult, Handler, Host } from './api.ts';

/** Shared state and helpers handed to every API handler module. */
export interface ApiCtx {
  host: Host;
  gitDir(repo: string): Promise<string>;
  repoState(repo: string): Promise<RepoState>;
  getStatus(repo: string): Promise<Status>;
  withConflicts(repo: string, run: () => Promise<unknown>): Promise<ConflictResult>;
  headExists(repo: string): Promise<boolean>;
  configGet(repo: string, key: string): Promise<string | undefined>;
  firstRemote(repo: string): Promise<string | undefined>;
  /** Call another handler by name */
  call<T = unknown>(method: string, args: object): Promise<T>;
}

export type HandlerModule = (ctx: ApiCtx) => Record<string, Handler>;
