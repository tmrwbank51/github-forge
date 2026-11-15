// The GraphQL v4 surface: a small parser and executor for the subset gh and
// github-mcp-server send — queries and mutations with variables, aliases,
// inline fragments, inline enum lists and input objects, plus __type
// introspection and operation batching. Unknown fields are GraphQL errors
// (HTTP 200 + errors), never HTTP errors; an unknown repository reads null.

import {
  branchTip,
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  pullRequestChanges,
  pullRequestMergeable,
  repoGlobalId,
  trialNowIso,
  VIEWER_LOGIN,
  type Forge,
  type IssueState,
  type PullState,
  type RepoState,
} from './store.ts';
import { squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(document: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < document.length) {
    const ch = document[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < document.length && document[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && document.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and regular strings with escapes.
      if (document.slice(index, index + 3) === '"""') {
        const end = document.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: document.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      let closed = false;
      while (index < document.length) {
        const c = document[index];
        if (c === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (c === '\\' && index + 1 < document.length) {
          const esc = document[index + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u' && index + 5 < document.length) {
            value += String.fromCharCode(Number.parseInt(document.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += escapes[esc] ?? esc;
            index += 2;
          }
          continue;
        }
        value += c;
        index += 1;
      }
      if (!closed) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(document.slice(index));
      if (match === null) throw new Error(`bad number at ${index}`);
      const text = match[0];
      index += text.length;
      if (match[1] !== undefined || match[2] !== undefined) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < document.length && isNameChar(document[end])) end += 1;
      tokens.push({ kind: 'name', value: document.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(what = 'name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next() as { value: string };
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName('operation name');
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          operation: operation.value as 'query' | 'mutation' | 'subscription',
          name,
          variables,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const onKeyword = this.expectName('"on"');
        if (onKeyword !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error('expected an operation or fragment definition');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(')) return variables;
    this.next();
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      variables.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('type condition');
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.expectName('fragment name');
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName('field name');
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName('field name');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName('variable name') };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
            const name = this.expectName('object field name');
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in value`);
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error('unexpected end of document in value');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// values and nodes
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

interface GqlNode {
  __type: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is GqlNode {
  return typeof value === 'object' && value !== null && typeof (value as GqlNode).__type === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class FieldError extends Error {}

// ---------------------------------------------------------------------------------------------
// the schema table (for __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
}

function userNode(login: string): GqlNode {
  return { __type: 'User', login };
}

function repoNode(forge: Forge, repo: RepoState): GqlNode {
  return { __type: 'Repository', forge, repo };
}

function issueNode(forge: Forge, repo: RepoState, issue: IssueState): GqlNode {
  return { __type: 'Issue', forge, repo, issue };
}

function pullNode(forge: Forge, repo: RepoState, pull: PullState): GqlNode {
  return { __type: 'PullRequest', forge, repo, pull };
}

function cursorFor(repo: RepoState, number: number): string {
  return Buffer.from(`cursor:${repo.id}:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'cursor' || parts.length !== 3) return null;
    const value = Number(parts[2]);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function issuesConnection(forge: Forge, repo: RepoState, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  const states = Array.isArray(args.states) ? args.states.map(String) : ['OPEN'];
  const wanted = new Set(states.map((state) => state.toLowerCase()));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  let issues = repo.issues.filter((issue) => wanted.has(issue.state));
  const compare = (a: IssueState, b: IssueState): number => {
    if (field === 'COMMENTS') {
      const ca = (repo.comments.get(a.number) ?? []).length;
      const cb = (repo.comments.get(b.number) ?? []).length;
      if (ca !== cb) return ca - cb;
    }
    return a.number - b.number;
  };
  issues.sort((a, b) => (direction === 'ASC' ? compare(a, b) : -compare(a, b)));
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const last = page[page.length - 1];
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueNode(forge, repo, issue)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(repo, page[0].number) : null,
      endCursor: last !== undefined ? cursorFor(repo, last.number) : null,
    },
  };
}

function decodeId(id: unknown, kind: string): { repoId: number; parts: string[] } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== kind) return null;
  const repoId = Number(parsed.parts[0]);
  if (!Number.isInteger(repoId)) return null;
  return { repoId, parts: parsed.parts };
}

function findRepoById(forge: Forge, repoId: number): RepoState | null {
  for (const repo of forge.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

type Resolver = (node: GqlNode, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(VIEWER_LOGIN),
    repository: (_node, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.resolveRepo(owner, name);
      return repo === null ? null : repoNode(ctx.forge, repo);
    },
    node: (_node, args, ctx) => {
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (parsed === null) return null;
      const repoId = Number(parsed.parts[0]);
      const repo = findRepoById(ctx.forge, repoId);
      if (repo === null) return null;
      if (parsed.kind === 'Repository') return repoNode(ctx.forge, repo);
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
        return issue === undefined ? null : issueNode(ctx.forge, repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.number === Number(parsed.parts[1]));
        return pull === undefined ? null : pullNode(ctx.forge, repo, pull);
      }
      return null;
    },
    __type: (_node, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return { __type: '__Type', typeName: name };
    },
  },
  Mutation: {
    createIssue: (_node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(input.repositoryId, 'Repository');
      if (decoded === null) throw new FieldError('repositoryId does not name a repository');
      const repo = findRepoById(ctx.forge, decoded.repoId);
      if (repo === null) throw new FieldError('repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new FieldError('title is required');
      const now = trialNowIso();
      const issue: IssueState = {
        id: ctx.forge.nextGlobalId(),
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return { __type: 'CreateIssuePayload', issue: issueNode(ctx.forge, repo, issue) };
    },
    closeIssue: (_node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(input.issueId, 'Issue');
      if (decoded === null) throw new FieldError('issueId does not name an issue');
      const repo = findRepoById(ctx.forge, decoded.repoId);
      const issue = repo?.issues.find((candidate) => candidate.number === Number(decoded.parts[1]));
      if (repo === null || issue === undefined) throw new FieldError('issueId does not name an issue');
      issue.state = 'closed';
      issue.closedAt = trialNowIso();
      issue.updatedAt = trialNowIso();
      return { __type: 'CloseIssuePayload', issue: issueNode(ctx.forge, repo, issue) };
    },
    createPullRequest: (_node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(input.repositoryId, 'Repository');
      if (decoded === null) throw new FieldError('repositoryId does not name a repository');
      const repo = findRepoById(ctx.forge, decoded.repoId);
      if (repo === null) throw new FieldError('repositoryId does not name a repository');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined) throw new FieldError(`head branch ${head} does not exist`);
      if (baseSha === undefined) throw new FieldError(`base branch ${base} does not exist`);
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new FieldError('title is required');
      const now = trialNowIso();
      const pull: PullState = {
        id: ctx.forge.nextGlobalId(),
        number: repo.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull) };
    },
    mergePullRequest: (_node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(input.pullRequestId, 'PullRequest');
      if (decoded === null) throw new FieldError('pullRequestId does not name a pull request');
      const repo = findRepoById(ctx.forge, decoded.repoId);
      const pull = repo?.pulls.find((candidate) => candidate.number === Number(decoded.parts[1]));
      if (repo === null || pull === undefined) throw new FieldError('pullRequestId does not name a pull request');
      const result = squashMerge(repo, pull);
      if (!result.ok) throw new FieldError(result.message);
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull) };
    },
    addComment: (_node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(input.subjectId, 'Issue');
      if (decoded === null) throw new FieldError('subjectId does not name an issue');
      const repo = findRepoById(ctx.forge, decoded.repoId);
      const issue = repo?.issues.find((candidate) => candidate.number === Number(decoded.parts[1]));
      if (repo === null || issue === undefined) throw new FieldError('subjectId does not name an issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const now = trialNowIso();
      const comment = { id: ctx.forge.nextGlobalId(), body, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: commentGlobalId(repo, issue.number, comment), body: comment.body },
        },
      };
    },
  },
  User: {
    login: (node) => node.login as string,
    id: () => globalId('User', 1000),
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Repository: {
    id: (node) => repoGlobalId(node.repo as RepoState),
    databaseId: (node) => (node.repo as RepoState).id,
    name: (node) => (node.repo as RepoState).name,
    nameWithOwner: (node, _args, ctx) => `${ctx.forge.ownerLogin(node.repo as RepoState)}/${(node.repo as RepoState).name}`,
    owner: (node, _args, ctx) => userNode(ctx.forge.ownerLogin(node.repo as RepoState)),
    defaultBranchRef: (node) => {
      const repo = node.repo as RepoState;
      if (branchTip(repo, repo.defaultBranch) === undefined) return null;
      return { __type: 'Ref', name: repo.defaultBranch, oid: branchTip(repo, repo.defaultBranch)! };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (node) => (node.repo as RepoState).description,
    isPrivate: (node) => (node.repo as RepoState).private,
    issue: (node, args, ctx) => {
      const repo = node.repo as RepoState;
      const number = typeof args.number === 'number' ? args.number : NaN;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : issueNode(ctx.forge, repo, issue);
    },
    issues: (node, args, ctx) => issuesConnection(ctx.forge, node.repo as RepoState, args),
    pullRequests: (node, args, ctx) => {
      const repo = node.repo as RepoState;
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
      const pulls = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
      return {
        __type: 'PullRequestConnection',
        nodes: pulls.slice(0, first).map((pull) => pullNode(ctx.forge, repo, pull)),
        pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    },
    pullRequest: (node, args, ctx) => {
      const repo = node.repo as RepoState;
      const number = typeof args.number === 'number' ? args.number : NaN;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : pullNode(ctx.forge, repo, pull);
    },
  },
  Issue: {
    id: (node) => issueGlobalId(node.repo as RepoState, node.issue as IssueState),
    number: (node) => (node.issue as IssueState).number,
    title: (node) => (node.issue as IssueState).title,
    body: (node) => (node.issue as IssueState).body,
    state: (node) => ((node.issue as IssueState).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => userNode(VIEWER_LOGIN),
    createdAt: (node) => (node.issue as IssueState).createdAt,
    updatedAt: (node) => (node.issue as IssueState).updatedAt,
    closedAt: (node) => (node.issue as IssueState).closedAt,
    url: (node, _args, ctx) => {
      const repo = node.repo as RepoState;
      const issue = node.issue as IssueState;
      return `https://github.com/${ctx.forge.ownerLogin(repo)}/${repo.name}/issues/${issue.number}`;
    },
  },
  IssueConnection: {
    nodes: (node) => node.nodes as GqlNode[],
    pageInfo: (node) => node.pageInfo as GqlNode,
    totalCount: (node) => (node.nodes as GqlNode[]).length,
  },
  PullRequestConnection: {
    nodes: (node) => node.nodes as GqlNode[],
    pageInfo: (node) => node.pageInfo as GqlNode,
    totalCount: (node) => (node.nodes as GqlNode[]).length,
  },
  PageInfo: {
    hasNextPage: (node) => node.hasNextPage as boolean,
    hasPreviousPage: (node) => node.hasPreviousPage as boolean,
    startCursor: (node) => node.startCursor as string | null,
    endCursor: (node) => node.endCursor as string | null,
  },
  PullRequest: {
    id: (node) => pullGlobalId(node.repo as RepoState, node.pull as PullState),
    number: (node) => (node.pull as PullState).number,
    title: (node) => (node.pull as PullState).title,
    body: (node) => (node.pull as PullState).body,
    state: (node) => {
      const pull = node.pull as PullState;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (node) => (node.pull as PullState).merged,
    headRefName: (node) => (node.pull as PullState).head,
    baseRefName: (node) => (node.pull as PullState).base,
    mergeable: (node) => {
      const repo = node.repo as RepoState;
      const pull = node.pull as PullState;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullRequestMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (node, args) => {
      const repo = node.repo as RepoState;
      const pull = node.pull as PullState;
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
      const changes = pullRequestChanges(repo, pull).slice(0, first);
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: changes.map((change) => ({ __type: 'PullRequestChangedFile', path: change.path, additions: change.additions, deletions: change.deletions })),
      };
    },
    author: () => userNode(VIEWER_LOGIN),
    createdAt: (node) => (node.pull as PullState).createdAt,
    updatedAt: (node) => (node.pull as PullState).updatedAt,
    mergedAt: (node) => (node.pull as PullState).mergedAt,
  },
  PullRequestChangedFileConnection: {
    nodes: (node) => node.nodes as GqlNode[],
  },
  PullRequestChangedFile: {
    path: (node) => node.path as string,
    additions: (node) => node.additions as number,
    deletions: (node) => node.deletions as number,
  },
  Ref: {
    name: (node) => node.name as string,
    oid: (node) => node.oid as string,
  },
  __Type: {
    name: (node) => node.typeName as string,
    kind: (node) => (ENUM_VALUES[node.typeName as string] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (node) => {
      const names = TYPE_FIELDS[node.typeName as string] ?? [];
      return names.map((name) => ({ __type: '__Field', name }));
    },
    enumValues: (node) => {
      const names = ENUM_VALUES[node.typeName as string] ?? [];
      return names.map((name) => ({ __type: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (node) => node.name as string,
  },
  __EnumValue: {
    name: (node) => node.name as string,
  },
  CreateIssuePayload: {
    issue: (node) => node.issue as GqlNode,
  },
  CloseIssuePayload: {
    issue: (node) => node.issue as GqlNode,
  },
  CreatePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as GqlNode,
  },
  MergePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as GqlNode,
  },
  AddCommentPayload: {
    commentEdge: (node) => node.commentEdge as GqlNode,
  },
  IssueCommentEdge: {
    node: (node) => node.node as GqlNode,
  },
  IssueComment: {
    id: (node) => node.id as string,
    body: (node) => node.body as string,
  },
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GraphQLErrorEntry {
  message: string;
  path?: Array<string | number>;
}

interface ExecCtx {
  forge: Forge;
  variables: Variables;
  fragments: Map<string, FragmentDef>;
  errors: GraphQLErrorEntry[];
}

function executeSelectionSet(
  selections: SelectionNode[],
  node: GqlNode,
  ctx: ExecCtx,
  path: Array<string | number>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== node.__type) continue;
      Object.assign(result, executeSelectionSet(fragment.selectionSet, node, ctx, path));
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== node.__type) continue;
      Object.assign(result, executeSelectionSet(selection.selectionSet, node, ctx, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      result[key] = node.__type;
      continue;
    }
    const resolver = RESOLVERS[node.__type]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${node.__type}".`,
        path: [...path, key],
      });
      result[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(node, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      result[key] = null;
      continue;
    }
    result[key] = completeValue(value, selection.selectionSet, ctx, [...path, key]);
  }
  return result;
}

function completeValue(
  value: unknown,
  selectionSet: SelectionNode[] | null,
  ctx: ExecCtx,
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(entry, selectionSet, ctx, [...path, index]));
  }
  if (isNode(value)) {
    if (selectionSet === null) return {};
    return executeSelectionSet(selectionSet, value, ctx, path);
  }
  return value;
}

export interface GraphQLReply {
  status: number;
  body: string;
}

function runOperation(
  forge: Forge,
  query: string,
  variables: Variables,
  operationName: string | undefined,
): { data: unknown; errors?: GraphQLErrorEntry[] } {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentDef> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in document' }] };
  }
  let operation = parsed.operations[0];
  if (operationName !== undefined) {
    operation = parsed.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  const mergedVariables: Variables = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== null) {
      mergedVariables[variable.name] = valueOf(variable.defaultValue, variables);
    }
  }
  const ctx: ExecCtx = { forge, variables: mergedVariables, fragments: parsed.fragments, errors: [] };
  const root: GqlNode = { __type: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(operation.selectionSet, root, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function handleGraphQL(forge: Forge, text: string): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Request body is not valid JSON' }] }) };
  }
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  void headers;
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched entry needs a query string' }] };
      }
      const variables = isRecord(entry.variables) ? entry.variables : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      return runOperation(forge, entry.query, variables, operationName);
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'A query string is required' }] }) };
  }
  const variables = isRecord(parsed.variables) ? parsed.variables : {};
  const operationName = typeof parsed.operationName === 'string' ? parsed.operationName : undefined;
  const result = runOperation(forge, parsed.query, variables, operationName);
  return { status: 200, body: JSON.stringify(result) };
}
