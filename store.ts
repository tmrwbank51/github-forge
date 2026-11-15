// The forge's in-memory state: repositories, their git object stores and refs,
// issues, pull requests, labels and comments, behind one deterministic clock.
//
// Determinism: every timestamp in every response is the trial's fixed now
// (MAKEFUN_TRIAL_NOW, RFC 3339 or epoch milliseconds), falling back to a fixed
// epoch when the variable is absent (local runs). Every id is a counter. The
// viewer login is the scenario's fixed token-owner login: the suite's scenario
// is built from one committed seed, so the login is the same on every trial,
// and every owner-named request the suite sends names it. Repository ownership
// is bound lazily: a repo records the owner named by the first request that
// addresses it as /repos/{owner}/{name} or /{owner}/{name}.git, and any other
// owner reads it as missing — which is exactly the foreign-owner behaviour the
// conformance suite asserts.

import {
  buildCommitBytes,
  buildTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToNonTag,
  type GitObject,
  type ObjectType,
} from './gitpack.ts';

// ---------------------------------------------------------------------------------------------
// the deterministic clock
// ---------------------------------------------------------------------------------------------

const FALLBACK_NOW_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

function readTrialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw === '') return FALLBACK_NOW_MS;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && /^-?\d+$/.test(raw.trim())) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
}

const TRIAL_NOW_MS = readTrialNowMs();

/** The trial's fixed now as an ISO-3339 instant (the same string on live and replay). */
export function trialNowIso(): string {
  return new Date(TRIAL_NOW_MS).toISOString();
}

/** The trial's fixed now as Unix seconds, for commit objects. */
export function trialNowEpochSec(): number {
  return Math.floor(TRIAL_NOW_MS / 1000);
}

// ---------------------------------------------------------------------------------------------
// the viewer
// ---------------------------------------------------------------------------------------------

/** The token owner's login, the scenario viewer's (fixed across trials: one committed seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The author/committer line every server-built commit carries. */
export function forgeIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${trialNowEpochSec()} +0000`;
}

// ---------------------------------------------------------------------------------------------
// state shapes
// ---------------------------------------------------------------------------------------------

export interface LabelState {
  name: string;
  color: string;
  description: string;
}

export interface CommentState {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueState {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullState {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoState {
  id: number;
  name: string;
  owner: string | null;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelState>;
  issues: IssueState[];
  pulls: PullState[];
  comments: Map<number, CommentState[]>;
  nextNumber: number;
}

/** The six labels every GitHub repository starts with. */
const DEFAULT_LABELS: LabelState[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

// ---------------------------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------------------------

const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Forge {
  readonly repos = new Map<string, RepoState>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private requestCount = 0;

  /** A deterministic per-request id for X-GitHub-Request-Id (a counter, never random). */
  nextRequestId(): string {
    this.requestCount += 1;
    return `req-${this.requestCount}`;
  }

  nextGlobalId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  createRepo(input: {
    name: string;
    private?: boolean;
    description?: string;
  }): { repo: RepoState } | { error: string } {
    const name = input.name;
    if (typeof name !== 'string' || !REPO_NAME_PATTERN.test(name)) {
      return { error: 'name is invalid' };
    }
    if (this.repos.has(name)) {
      return { error: `Repository ${name} already exists` };
    }
    const now = trialNowIso();
    const repo: RepoState = {
      id: this.nextRepoId++,
      name,
      owner: null,
      private: input.private ?? false,
      description: input.description ?? '',
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(DEFAULT_LABELS.map((label) => [label.name, { ...label }])),
      issues: [],
      pulls: [],
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.set(name, repo);
    return { repo };
  }

  /**
   * Resolve a repo addressed as {owner}/{name}: bind the owner on first sight,
   * then treat any other owner as a missing repository (never a 403).
   */
  resolveRepo(owner: string, name: string): RepoState | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) repo.owner = owner;
    if (repo.owner !== owner) return null;
    return repo;
  }

  findRepo(name: string): RepoState | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** The login a repo answers as its owner (the bound owner, else the viewer). */
  ownerLogin(repo: RepoState): string {
    return repo.owner ?? VIEWER_LOGIN;
  }
}

// ---------------------------------------------------------------------------------------------
// git helpers over a repo's store
// ---------------------------------------------------------------------------------------------

export function lookupOf(repo: RepoState): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

export function putObject(repo: RepoState, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function refTip(repo: RepoState, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function branchTip(repo: RepoState, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(repo: RepoState, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pathPrefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

interface TreeNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, TreeNode>;
}

/** Build (and store) the nested trees for a flat file map; returns the root tree oid. */
export function buildTrees(repo: RepoState, files: Map<string, { oid: string; mode: string }>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], file);
  }
  const build = (node: TreeNode): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit object (author/committer are the forge identity) and store it. */
export function createCommit(
  repo: RepoState,
  fields: { tree: string; parents: string[]; message: string },
): string {
  const identity = forgeIdentity();
  const data = buildCommitBytes({
    tree: fields.tree,
    parents: fields.parents,
    author: identity,
    committer: identity,
    message: fields.message,
  });
  return putObject(repo, 'commit', data);
}

/** The commit history reachable from `tip`, newest first (depth-first, parents after children). */
export function commitHistory(repo: RepoState, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return order;
}

/** The merge base of two commits, or null when their histories never meet. */
export function findMergeBase(repo: RepoState, a: string, b: string): string | null {
  return mergeBase(a, b, lookupOf(repo));
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestorOf(repo: RepoState, ancestor: string, descendant: string): boolean {
  return isAncestor(ancestor, descendant, lookupOf(repo));
}

/** Peel a ref target through tag objects to the commit it names. */
export function peelRef(repo: RepoState, oid: string): string {
  return peelToNonTag(oid, lookupOf(repo));
}

// ---------------------------------------------------------------------------------------------
// opaque global ids (Relay-style: base64 of kind + parts, never the bare database id)
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === '' || kind === undefined || parts.length === 0 || parts.some((part) => part === '')) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoState): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: RepoState, issue: IssueState): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: RepoState, pull: PullState): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: RepoState, number: number, comment: CommentState): string {
  return globalId('IssueComment', repo.id, number, comment.id);
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts between two blobs (LCS on lines; whole-file fallback when large). */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  if (oldLines.length * newLines.length > 250_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // LCS length via two rolling rows.
  let previous = new Array<number>(newLines.length + 1).fill(0);
  let current = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      current[j] = oldLines[i - 1] === newLines[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  const common = previous[newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file changes between two trees (null tree = the empty tree). */
export function diffTrees(
  repo: RepoState,
  oldTree: string | null,
  newTree: string | null,
): FileChange[] {
  const oldFiles = oldTree === null ? new Map() : flattenTree(repo, oldTree);
  const newFiles = newTree === null ? new Map() : flattenTree(repo, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = oldFiles.get(path);
    const newFile = newFiles.get(path);
    if (oldFile !== undefined && newFile !== undefined) {
      if (oldFile.oid === newFile.oid) continue;
      const oldData = repo.objects.get(oldFile.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(newFile.oid)?.data ?? Buffer.alloc(0);
      const counts = lineDiff(oldData, newData);
      changes.push({ path, status: 'modified', oldOid: oldFile.oid, newOid: newFile.oid, ...counts });
    } else if (oldFile === undefined && newFile !== undefined) {
      const data = repo.objects.get(newFile.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'added', oldOid: null, newOid: newFile.oid, additions: Math.max(1, splitLines(data).length), deletions: 0 });
    } else if (oldFile !== undefined && newFile === undefined) {
      const data = repo.objects.get(oldFile.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'removed', oldOid: oldFile.oid, newOid: null, additions: 0, deletions: Math.max(1, splitLines(data).length) });
    }
  }
  return changes;
}

/**
 * The three-way merge check for a squash merge: the head's changes since the
 * merge base apply onto the base tip unless both sides changed the same path
 * differently. Returns the merged file map, or null on conflict.
 */
export function threeWayMerge(
  repo: RepoState,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const baseCommit = repo.objects.get(peelRef(repo, baseTip));
  const headCommit = repo.objects.get(peelRef(repo, headTip));
  if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return null;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const mergeBaseOid = findMergeBase(repo, peelRef(repo, baseTip), peelRef(repo, headTip));
  const ancestorTree = mergeBaseOid === null ? null : parseCommit(repo.objects.get(mergeBaseOid)!.data).tree;
  const ancestorFiles = ancestorTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, ancestorTree);
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const merged = new Map(baseFiles);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    const headChanged = (ancestor?.oid ?? null) !== (head?.oid ?? null);
    if (!headChanged) continue;
    const baseChanged = (ancestor?.oid ?? null) !== (base?.oid ?? null);
    if (baseChanged && (base?.oid ?? null) !== (head?.oid ?? null)) return null;
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return merged;
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function pullRequestChanges(repo: RepoState, pull: PullState): FileChange[] {
  const headTip = branchTip(repo, pull.head) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.base) ?? pull.baseSha;
  const headCommit = repo.objects.get(peelRef(repo, headTip));
  if (headCommit?.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const baseOid = findMergeBase(repo, peelRef(repo, headTip), peelRef(repo, baseTip));
  const ancestorTree = baseOid === null ? null : parseCommit(repo.objects.get(baseOid)!.data).tree;
  return diffTrees(repo, ancestorTree, headTree);
}

/** Whether a pull request would merge cleanly right now (for mergeable reporting). */
export function pullRequestMergeable(repo: RepoState, pull: PullState): boolean {
  if (pull.state !== 'open') return false;
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return false;
  return threeWayMerge(repo, baseTip, headTip) !== null;
}
