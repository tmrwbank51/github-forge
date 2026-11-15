// The MCP surface: JSON-RPC over POST /mcp, speaking the modern 2026-07-28
// era (server/discover, no handshake, no session) and the legacy initialize
// handshake for older clients. Six tools over the same store the REST surface
// reads, so a repository or issue created over MCP is the same object over REST.

import {
  branchTip,
  trialNowIso,
  VIEWER_LOGIN,
  type Forge,
  type IssueState,
  type PullState,
  type RepoState,
} from './store.ts';
import { issueShape, pullShape, repoShape, squashMerge } from './rest.ts';

export interface McpRequest {
  forge: Forge;
  /** The raw request body text. */
  text: string;
  origin: string;
}

export interface McpReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

// ---------------------------------------------------------------------------------------------
// the tool catalogue (one frozen value: tools/list answers byte-identically every time)
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'The repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login the repository belongs to.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
        additionalProperties: false,
      },
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

type RpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultEnvelope(id: RpcId, result: unknown): McpReply {
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function errorEnvelope(id: RpcId, code: number, message: string, status = 200): McpReply {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

// ---------------------------------------------------------------------------------------------
// argument handling
// ---------------------------------------------------------------------------------------------

/** Read owner/repo out of a tool's arguments, accepting a full_name fallback. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repo = typeof args.repo === 'string' ? args.repo : undefined;
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const [fullOwner, fullRepo] = args.full_name.split('/');
    owner ??= fullOwner;
    repo ??= fullRepo;
  }
  if (owner === undefined || owner === '' || repo === undefined || repo === '') return null;
  return { owner, repo };
}

function requiredArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

// ---------------------------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------------------------

function createRepoTool(forge: Forge, origin: string, args: Record<string, unknown>): Record<string, unknown> {
  const name = typeof args.name === 'string' ? args.name : '';
  const created = forge.createRepo({
    name,
    private: typeof args.private === 'boolean' ? args.private : undefined,
    description: typeof args.description === 'string' ? args.description : undefined,
  });
  if ('error' in created) return toolResult({ error: created.error }, true);
  const repo = created.repo;
  if (typeof args.owner === 'string' && args.owner !== '') repo.owner = args.owner;
  else repo.owner = VIEWER_LOGIN;
  return toolResult(repoShape(forge, repo, { origin }));
}

function getRepoTool(forge: Forge, origin: string, args: Record<string, unknown>): Record<string, unknown> {
  const target = repoArgs(args);
  if (target === null) return toolResult({ error: 'owner and repo are required' }, true);
  const repo = forge.resolveRepo(target.owner, target.repo);
  if (repo === null) return toolResult({ error: 'Not Found' }, true);
  return toolResult(repoShape(forge, repo, { origin }));
}

function createIssueTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const target = repoArgs(args);
  if (target === null) return toolResult({ error: 'owner and repo are required' }, true);
  const repo = forge.resolveRepo(target.owner, target.repo);
  if (repo === null) return toolResult({ error: 'Not Found' }, true);
  const title = typeof args.title === 'string' ? args.title : '';
  const now = trialNowIso();
  const issue: IssueState = {
    id: forge.nextGlobalId(),
    number: repo.nextNumber++,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  return toolResult(issueShape(forge, repo, issue));
}

function listIssuesTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const target = repoArgs(args);
  if (target === null) return toolResult({ error: 'owner and repo are required' }, true);
  const repo = forge.resolveRepo(target.owner, target.repo);
  if (repo === null) return toolResult({ error: 'Not Found' }, true);
  const state = typeof args.state === 'string' ? args.state : 'open';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => b.number - a.number);
  return toolResult(issues.map((issue) => issueShape(forge, repo, issue)));
}

function createPullRequestTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const target = repoArgs(args);
  if (target === null) return toolResult({ error: 'owner and repo are required' }, true);
  const repo = forge.resolveRepo(target.owner, target.repo);
  if (repo === null) return toolResult({ error: 'Not Found' }, true);
  const title = typeof args.title === 'string' ? args.title : '';
  const head = typeof args.head === 'string' ? args.head : '';
  const base = typeof args.base === 'string' ? args.base : '';
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined) return toolResult({ error: `head branch ${head} does not exist` }, true);
  if (baseSha === undefined) return toolResult({ error: `base branch ${base} does not exist` }, true);
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
  if (duplicate !== undefined) return toolResult({ error: 'A pull request already exists for this head and base' }, true);
  const now = trialNowIso();
  const pull: PullState = {
    id: forge.nextGlobalId(),
    number: repo.nextNumber++,
    title,
    body: typeof args.body === 'string' ? args.body : '',
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
  return toolResult(pullShape(forge, repo, pull));
}

function mergePullRequestTool(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const target = repoArgs(args);
  if (target === null) return toolResult({ error: 'owner and repo are required' }, true);
  const repo = forge.resolveRepo(target.owner, target.repo);
  if (repo === null) return toolResult({ error: 'Not Found' }, true);
  const rawNumber = args.pull_number;
  const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
  if (!Number.isInteger(number)) return toolResult({ error: 'pull_number must be an integer' }, true);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return toolResult({ error: 'Not Found' }, true);
  const result = squashMerge(repo, pull);
  if (!result.ok) return toolResult({ error: result.message, merged: false }, true);
  return toolResult({ ...pullShape(forge, repo, pull), merged: true, sha: result.sha });
}

const TOOL_RUNNERS: Record<string, (forge: Forge, origin: string, args: Record<string, unknown>) => Record<string, unknown>> = {
  create_repo: (forge, origin, args) => createRepoTool(forge, origin, args),
  get_repo: (forge, origin, args) => getRepoTool(forge, origin, args),
  create_issue: (forge, _origin, args) => createIssueTool(forge, args),
  list_issues: (forge, _origin, args) => listIssuesTool(forge, args),
  create_pull_request: (forge, _origin, args) => createPullRequestTool(forge, args),
  merge_pull_request: (forge, _origin, args) => mergePullRequestTool(forge, args),
};

// ---------------------------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------------------------

export function handleMcp(request: McpRequest): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.text);
  } catch {
    return errorEnvelope(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) {
    return errorEnvelope(null, -32600, 'Invalid Request');
  }
  const id: RpcId = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  const isNotification = parsed.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return resultEnvelope(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const legacy = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const negotiated = legacy.includes(offered) ? offered : '2025-11-25';
      return resultEnvelope(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return resultEnvelope(id, {});
    case 'tools/list':
      return resultEnvelope(id, toolsList());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return errorEnvelope(id, -32602, `Unknown tool: ${name}`);
      }
      const missing = requiredArgs(tool, args);
      if (missing.length > 0) {
        return errorEnvelope(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      }
      try {
        const outcome = TOOL_RUNNERS[name](request.forge, request.origin, args);
        return resultEnvelope(id, outcome);
      } catch (err) {
        return errorEnvelope(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return errorEnvelope(id, -32601, `Method not found: ${method}`);
  }
}
