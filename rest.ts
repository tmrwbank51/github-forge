// The REST v3 surface: repositories, contents, git refs, issues, pull requests.
//
// Every reply is JSON (application/json), every reply carries X-GitHub-Request-Id
// (set by the router), and every error body carries a string `message`.
// Authentication is decided by the router before this module runs.

import {
  branchTip,
  buildTrees,
  commentGlobalId,
  commitHistory,
  createCommit,
  diffTrees,
  flattenTree,
  issueGlobalId,
  lineDiff,
  pullGlobalId,
  pullRequestChanges,
  pullRequestMergeable,
  putObject,
  repoGlobalId,
  threeWayMerge,
  trialNowIso,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Forge,
  type IssueState,
  type PullState,
  type RepoState,
} from './store.ts';
import { parseCommit, parseTree } from './gitpack.ts';

export interface RestRequest {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, percent-decoded, without empty segments. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when the request carried none). */
  body: unknown;
  /** True when a non-empty body was present but was not valid JSON. */
  bodyMalformed: boolean;
  /** Absolute base URL for pagination links (http://host). */
  origin: string;
}

export interface RestReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function reply(status: number, value: unknown, extra: Record<string, string> = {}): RestReply {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(value) };
}

function failure(status: number, message: string): RestReply {
  return reply(status, { message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(request: RestRequest): Record<string, unknown> {
  return isRecord(request.body) ? request.body : {};
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], request: RestRequest, path: string): { items: T[]; link: string } {
  const { page, perPage } = pageOf(request.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, totalPages);
  const slice = items.slice((current - 1) * perPage, current * perPage);
  const linkFor = (target: number, rel: string): string => {
    const params = new URLSearchParams(request.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<${request.origin}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (current < totalPages) links.push(linkFor(current + 1, 'next'));
  if (current > 1) links.push(linkFor(current - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return { items: slice, link: links.join(', ') };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userShape(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' };
}

export function repoShape(forge: Forge, repo: RepoState, request: { origin: string }): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userShape(owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `${request.origin}/api/v3/repos/${owner}/${repo.name}`,
  };
}

function labelShape(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueShape(forge: Forge, repo: RepoState, issue: IssueState): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelShape(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: userShape(VIEWER_LOGIN),
    assignee: null,
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function refShape(forge: Forge, repo: RepoState, branch: string, sha: string): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  return {
    ref: branch,
    sha,
    label: `${owner}:${branch}`,
    user: userShape(owner),
    repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}` },
  };
}

export function pullShape(forge: Forge, repo: RepoState, pull: PullState): Record<string, unknown> {
  const owner = forge.ownerLogin(repo);
  const headSha = branchTip(repo, pull.head) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.base) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullRequestMergeable(repo, pull),
    head: refShape(forge, repo, pull.head, headSha),
    base: refShape(forge, repo, pull.base, baseSha),
    user: userShape(VIEWER_LOGIN),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentShape(repo: RepoState, number: number, comment: { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, number, comment),
    body: comment.body,
    user: userShape(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function identityOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: trialNowIso() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitShape(repo: RepoState, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = identityOf(commit.author);
  const committer = identityOf(commit.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`, 'utf8').toString('base64'),
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: userShape(VIEWER_LOGIN),
    committer: userShape(VIEWER_LOGIN),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function resolveRepo(request: RestRequest, owner: string, name: string): RepoState | null {
  return request.forge.resolveRepo(owner, name);
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Resolve a ref query (?ref= / ?sha=): a branch name, a full ref, or a commit id. */
function resolveRefTip(repo: RepoState, ref: string | null): string | undefined {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const direct = branchTip(repo, ref);
  if (direct !== undefined) return direct;
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(request: RestRequest): RestReply {
  const { method, segments } = request;
  if (request.bodyMalformed) return failure(400, 'Problems parsing JSON');

  // GET /api/v3[/] — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return failure(404, 'Not Found');
    return reply(
      200,
      {
        current_user_url: `${request.origin}/api/v3/user`,
        rate_limit_url: `${request.origin}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return failure(404, 'Not Found');
    return reply(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return failure(404, 'Not Found');
    return reply(200, { ...userShape(VIEWER_LOGIN), name: 'ada iversen', email: VIEWER_EMAIL });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(request);
    if (method === 'GET') {
      const { items, link } = paginate(request.forge.listRepos(), request, '/api/v3/user/repos');
      return reply(200, items.map((repo) => repoShape(request.forge, repo, request)), { link });
    }
    return failure(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    return handleRepo(request, segments[1], segments[2], segments.slice(3));
  }

  return failure(404, 'Not Found');
}

function createRepo(request: RestRequest): RestReply {
  const body = bodyOf(request);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') return failure(422, 'name is required');
  const created = request.forge.createRepo({
    name,
    private: typeof body.private === 'boolean' ? body.private : undefined,
    description: stringField(body, 'description'),
  });
  if ('error' in created) {
    const status = created.error.includes('already exists') ? 422 : 422;
    return failure(status, created.error);
  }
  return reply(201, repoShape(request.forge, created.repo, request));
}

function handleRepo(request: RestRequest, owner: string, name: string, rest: string[]): RestReply {
  const { method } = request;
  const repo = resolveRepo(request, owner, name);
  if (repo === null) return failure(404, 'Not Found');

  // /repos/{owner}/{name}
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoShape(request.forge, repo, request));
    if (method === 'PATCH') {
      const body = bodyOf(request);
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      const defaultBranch = stringField(body, 'default_branch');
      if (defaultBranch !== undefined && branchTip(repo, defaultBranch) !== undefined) repo.defaultBranch = defaultBranch;
      repo.updatedAt = trialNowIso();
      return reply(200, repoShape(request.forge, repo, request));
    }
    if (method === 'DELETE') {
      request.forge.deleteRepo(name);
      return { status: 204, headers: {}, body: '' };
    }
    return failure(404, 'Not Found');
  }

  const [head, ...tail] = rest;
  switch (head) {
    case 'branches':
      return handleBranches(request, repo, tail);
    case 'commits':
      return handleCommits(request, repo, tail);
    case 'contents':
      return handleContents(request, repo, tail);
    case 'labels':
      return handleLabels(request, repo, tail);
    case 'issues':
      return handleIssues(request, repo, tail);
    case 'pulls':
      return handlePulls(request, repo, tail);
    case 'git':
      return handleGitData(request, repo, tail);
    default:
      return failure(404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------------------------

function handleBranches(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method !== 'GET') return failure(404, 'Not Found');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    const { items, link } = paginate(branches, request, `/api/v3/repos/${repo.owner ?? VIEWER_LOGIN}/${repo.name}/branches`);
    return reply(
      200,
      items.map((branch) => ({ name: branch, commit: { sha: branchTip(repo, branch)! }, protected: false })),
      { link },
    );
  }
  if (method !== 'GET') return failure(404, 'Not Found');
  const branch = tail.join('/');
  const tip = branchTip(repo, branch);
  if (tip === undefined) return failure(404, 'Branch not found');
  return reply(200, { name: branch, commit: { sha: tip, commit: commitShape(repo, tip)?.commit ?? null }, protected: false });
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

function handleCommits(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  if (request.method !== 'GET') return failure(404, 'Not Found');
  if (tail.length > 0) {
    const shape = commitShape(repo, tail.join('/'));
    if (shape === null) return failure(404, 'Not Found');
    return reply(200, shape);
  }
  const tip = resolveRefTip(repo, request.query.get('sha'));
  if (tip === undefined) return reply(200, []);
  const history = commitHistory(repo, tip);
  const { items, link } = paginate(history, request, `/api/v3/repos/${repo.owner ?? VIEWER_LOGIN}/${repo.name}/commits`);
  const shapes = items.map((sha) => commitShape(repo, sha)).filter((shape): shape is Record<string, unknown> => shape !== null);
  return reply(200, shapes, { link });
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) return failure(404, 'Not Found');
  const path = tail.join('/');
  if (method === 'GET') return getContents(request, repo, path);
  if (method === 'PUT') return putContents(request, repo, path);
  if (method === 'DELETE') return deleteContents(request, repo, path);
  return failure(404, 'Not Found');
}

function getContents(request: RestRequest, repo: RepoState, path: string): RestReply {
  const tip = resolveRefTip(repo, request.query.get('ref'));
  if (tip === undefined) return failure(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return failure(404, 'Not Found');
  const files = flattenTree(repo, parseCommit(commit.data).tree);
  const file = files.get(path);
  if (file !== undefined) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    const name = path.split('/').pop() ?? path;
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name,
      path,
      content: data.toString('base64'),
      sha: file.oid,
    });
  }
  // A directory: the immediate children under path/.
  const prefix = `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', oid: '', size: 0 });
    }
  }
  if (children.size === 0) return failure(404, 'Not Found');
  // Directory entries need the subtree oid: recompute from the tree walk.
  const entries = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([childName, child]) => ({
      type: child.type,
      name: childName,
      path: `${path}/${childName}`,
      sha: child.type === 'file' ? child.oid : dirTreeOid(repo, parseCommit(commit.data).tree, `${path}/${childName}`) ?? '',
      size: child.size,
    }));
  return reply(200, entries);
}

function dirTreeOid(repo: RepoState, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function putContents(request: RestRequest, repo: RepoState, path: string): RestReply {
  const body = bodyOf(request);
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  if (message === undefined) return failure(422, 'message is required');
  if (content === undefined) return failure(422, 'content is required');
  let data: Buffer;
  try {
    data = Buffer.from(content, 'base64');
  } catch {
    return failure(422, 'content is not valid base64');
  }
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const givenSha = stringField(body, 'sha');
  let tip = branchTip(repo, branch);
  let parents: string[] = [];
  let files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    parents = [tip];
    const commit = repo.objects.get(tip);
    if (commit !== undefined && commit.type === 'commit') files = flattenTree(repo, parseCommit(commit.data).tree);
  } else {
    // A new branch starts from the default branch tip when there is one (the
    // contents route that creates a branch), else from the empty tree.
    const base = branch === repo.defaultBranch ? undefined : branchTip(repo, repo.defaultBranch);
    if (base !== undefined) {
      tip = base;
      parents = [base];
      const commit = repo.objects.get(base);
      if (commit !== undefined && commit.type === 'commit') files = flattenTree(repo, parseCommit(commit.data).tree);
    }
  }
  const existing = files.get(path);
  if (givenSha !== undefined) {
    if (existing === undefined) return failure(422, 'sha does not match any file at this path');
    if (existing.oid !== givenSha) return failure(409, 'sha does not match the current file');
  } else if (existing !== undefined) {
    return failure(422, 'file already exists');
  }
  const blobOid = putObject(repo, 'blob', data);
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTrees(repo, files);
  const commitOid = createCommit(repo, { tree: treeOid, parents, message });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = trialNowIso();
  const name = path.split('/').pop() ?? path;
  return reply(existing === undefined ? 201 : 200, {
    content: { name, path, sha: blobOid, size: data.length, encoding: 'base64', content: data.toString('base64') },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(request: RestRequest, repo: RepoState, path: string): RestReply {
  const body = bodyOf(request);
  const message = stringField(body, 'message');
  if (message === undefined) return failure(422, 'message is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return failure(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return failure(404, 'Not Found');
  const files = flattenTree(repo, parseCommit(commit.data).tree);
  const existing = files.get(path);
  if (existing === undefined) return failure(404, 'Not Found');
  const givenSha = stringField(body, 'sha');
  if (givenSha !== undefined && givenSha !== existing.oid) return failure(409, 'sha does not match the current file');
  files.delete(path);
  const treeOid = buildTrees(repo, files);
  const commitOid = createCommit(repo, { tree: treeOid, parents: [tip], message });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = trialNowIso();
  return reply(200, { content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function handleLabels(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length !== 0) return failure(404, 'Not Found');
  if (method === 'GET') {
    return reply(200, [...repo.labels.values()].map(labelShape));
  }
  if (method === 'POST') {
    const body = bodyOf(request);
    const name = stringField(body, 'name');
    if (name === undefined || name === '') return failure(422, 'name is required');
    const color = stringField(body, 'color') ?? 'ededed';
    const description = stringField(body, 'description') ?? '';
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      existing.color = color;
      existing.description = description;
      return reply(201, labelShape(existing));
    }
    const label = { name, color, description };
    repo.labels.set(name, label);
    return reply(201, labelShape(label));
  }
  return failure(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function resolveLabelNames(repo: RepoState, labels: unknown): { names: string[] } | { error: string } {
  if (labels === undefined) return { names: [] };
  if (!Array.isArray(labels)) return { error: 'labels must be an array' };
  const names: string[] = [];
  for (const entry of labels) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? stringField(entry, 'name') : undefined;
    if (name === undefined) return { error: 'labels must be names' };
    const canonical = [...repo.labels.keys()].find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (canonical === undefined) return { error: `Label '${name}' does not exist` };
    if (!names.includes(canonical)) names.push(canonical);
  }
  return { names };
}

function handleIssues(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = bodyOf(request);
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return failure(422, 'title is required');
      const labels = resolveLabelNames(repo, body.labels);
      if ('error' in labels) return failure(422, labels.error);
      const now = trialNowIso();
      const issue: IssueState = {
        id: request.forge.nextGlobalId(),
        number: repo.nextNumber++,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        labels: labels.names,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return reply(201, issueShape(request.forge, repo, issue));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { items, link } = paginate(issues, request, `/api/v3/repos/${repo.owner ?? VIEWER_LOGIN}/${repo.name}/issues`);
      return reply(200, items.map((issue) => issueShape(request.forge, repo, issue)), { link });
    }
    return failure(404, 'Not Found');
  }
  const number = parseNumber(tail[0]);
  if (number === null) return failure(404, 'Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) return failure(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return reply(200, issueShape(request.forge, repo, issue));
    if (method === 'PATCH') {
      const body = bodyOf(request);
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = stringField(body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? trialNowIso() : null;
      }
      if (body.labels !== undefined) {
        const labels = resolveLabelNames(repo, body.labels);
        if ('error' in labels) return failure(422, labels.error);
        issue.labels = labels.names;
      }
      issue.updatedAt = trialNowIso();
      return reply(200, issueShape(request.forge, repo, issue));
    }
    return failure(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return reply(200, comments.map((comment) => commentShape(repo, number, comment)));
    }
    if (method === 'POST') {
      const body = bodyOf(request);
      const text = stringField(body, 'body');
      if (text === undefined) return failure(422, 'body is required');
      const now = trialNowIso();
      const comment = { id: request.forge.nextGlobalId(), body: text, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return reply(201, commentShape(repo, number, comment));
    }
  }
  return failure(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length === 0) {
    if (method === 'POST') return createPull(request, repo);
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { items, link } = paginate(pulls, request, `/api/v3/repos/${repo.owner ?? VIEWER_LOGIN}/${repo.name}/pulls`);
      return reply(200, items.map((pull) => pullShape(request.forge, repo, pull)), { link });
    }
    return failure(404, 'Not Found');
  }
  const number = parseNumber(tail[0]);
  if (number === null) return failure(404, 'Not Found');
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return failure(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return reply(200, pullShape(request.forge, repo, pull));
    if (method === 'PATCH') {
      const body = bodyOf(request);
      const title = stringField(body, 'title');
      if (title !== undefined) pull.title = title;
      const bodyText = stringField(body, 'body');
      if (bodyText !== undefined) pull.body = bodyText;
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') {
        pull.state = state;
        pull.closedAt = state === 'closed' ? trialNowIso() : null;
      }
      pull.updatedAt = trialNowIso();
      return reply(200, pullShape(request.forge, repo, pull));
    }
    return failure(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const changes = pullRequestChanges(repo, pull);
    return reply(
      200,
      changes.map((change) => ({
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
      })),
    );
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    return mergePull(request, repo, pull);
  }
  return failure(404, 'Not Found');
}

function createPull(request: RestRequest, repo: RepoState): RestReply {
  const body = bodyOf(request);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || title === '') return failure(422, 'title is required');
  if (head === undefined || head === '') return failure(422, 'head is required');
  if (base === undefined || base === '') return failure(422, 'base is required');
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined) return failure(422, `head branch ${head} does not exist`);
  if (baseSha === undefined) return failure(422, `base branch ${base} does not exist`);
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
  if (duplicate !== undefined) return failure(422, 'A pull request already exists for this head and base');
  const now = trialNowIso();
  const pull: PullState = {
    id: request.forge.nextGlobalId(),
    number: repo.nextNumber++,
    title,
    body: stringField(body, 'body') ?? '',
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.push(pull);
  return reply(201, pullShape(request.forge, repo, pull));
}

/** The shared squash-merge used by REST, GraphQL and MCP alike. */
export function squashMerge(
  repo: RepoState,
  pull: PullState,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull request has already been merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is closed' };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) {
    return { ok: false, status: 405, message: 'Head or base branch does not exist' };
  }
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return { ok: false, status: 405, message: 'Merge conflict' };
  const treeOid = buildTrees(repo, merged);
  const message = `${pull.title} (#${pull.number})`;
  const commitOid = createCommit(repo, { tree: treeOid, parents: [baseTip], message });
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  const now = trialNowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = commitOid;
  repo.updatedAt = now;
  return { ok: true, sha: commitOid };
}

function mergePull(request: RestRequest, repo: RepoState, pull: PullState): RestReply {
  const result = squashMerge(repo, pull);
  if (!result.ok) return failure(result.status, result.message);
  return reply(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// git data
// ---------------------------------------------------------------------------------------------

function handleGitData(request: RestRequest, repo: RepoState, tail: string[]): RestReply {
  const { method } = request;
  if (tail.length >= 1 && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const body = bodyOf(request);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || !ref.startsWith('refs/')) return failure(422, 'ref is required');
      if (sha === undefined) return failure(422, 'sha is required');
      if (repo.objects.get(sha) === undefined) return failure(422, 'sha does not name an object');
      if (repo.refs.has(ref)) return failure(422, 'ref already exists');
      repo.refs.set(ref, sha);
      return reply(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) return failure(404, 'Not Found');
      return reply(200, { ref, object: { sha: tip, type: repo.objects.get(tip)?.type ?? 'commit' } });
    }
  }
  return failure(404, 'Not Found');
}

// Re-exported for the diff helper's line counts in other surfaces (kept local otherwise).
export { diffTrees, lineDiff };
