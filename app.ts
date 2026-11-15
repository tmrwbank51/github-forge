// The entry's HTTP router: one in-memory forge behind four surfaces.
//
//   GET  /healthz                 liveness (no auth, the env's probe)
//   /api/v3/...                   REST v3 (rest.ts)
//   POST /api/graphql             GraphQL v4 (graphql.ts)
//   POST /mcp                     MCP tools (mcp.ts)
//   /{owner}/{repo}.git/...       git smart-HTTP (gitproto.ts)
//
// Authentication: every surface except /healthz requires
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` when the trial sets that
// variable; anything else answers 401 with a JSON message. Every response
// carries X-GitHub-Request-Id. No wall clock, no randomness, no model calls.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function sendJson(response: ServerResponse, status: number, value: unknown, requestId: string): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function createApp(): Server {
  const forge = new Forge();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer(async (request, response) => {
    const requestId = forge.nextRequestId();
    try {
      const url = new URL(request.url ?? '/', 'http://forge.invalid');
      const method = request.method ?? 'GET';
      const segments = decodeSegments(url.pathname);

      // Liveness: the env's probe, unauthenticated.
      if (url.pathname === '/healthz' && method === 'GET') {
        sendJson(response, 200, { ok: true }, requestId);
        return;
      }

      // Authentication for every other surface.
      if (shopToken !== '') {
        const presented = request.headers.authorization ?? '';
        if (presented !== `Bearer ${shopToken}`) {
          sendJson(response, 401, { message: 'Bad credentials' }, requestId);
          return;
        }
      }

      const origin = `http://${request.headers.host ?? 'localhost'}`;
      const body = await readBody(request);

      // GraphQL.
      if (url.pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(response, 405, { errors: [{ message: 'Method not allowed' }] }, requestId);
          return;
        }
        const result = handleGraphQL(forge, body.toString('utf8'));
        response.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'x-github-request-id': requestId,
          'content-length': Buffer.byteLength(result.body),
        });
        response.end(result.body);
        return;
      }

      // MCP.
      if (url.pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(response, 405, { message: 'Method not allowed' }, requestId);
          return;
        }
        const result = handleMcp({ forge, text: body.toString('utf8'), origin });
        const headers: Record<string, string> = { ...result.headers, 'x-github-request-id': requestId };
        if (result.body !== '') headers['content-length'] = String(Buffer.byteLength(result.body));
        response.writeHead(result.status, headers);
        response.end(result.body);
        return;
      }

      // REST v3.
      if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
        const restSegments = decodeSegments(url.pathname.slice('/api/v3'.length));
        let parsedBody: unknown;
        let bodyMalformed = false;
        if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && body.length > 0) {
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            bodyMalformed = true;
          }
        }
        const result = handleRest({
          forge,
          method,
          segments: restSegments,
          query: url.searchParams,
          body: parsedBody,
          bodyMalformed,
          origin,
        });
        const headers: Record<string, string> = { ...result.headers, 'x-github-request-id': requestId };
        if (result.status !== 204) headers['content-length'] = String(Buffer.byteLength(result.body));
        response.writeHead(result.status, headers);
        response.end(result.status === 204 ? undefined : result.body);
        return;
      }

      // Git smart-HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
        const result = handleGit({
          forge,
          method,
          owner: segments[0],
          repoName: segments[1].slice(0, -'.git'.length),
          suffix: segments.slice(2),
          query: url.searchParams,
          headers,
          body,
        });
        response.writeHead(result.status, { ...result.headers, 'x-github-request-id': requestId, 'content-length': result.body.length });
        response.end(result.body);
        return;
      }

      sendJson(response, 404, { message: 'Not Found' }, requestId);
    } catch (err) {
      // Never crash the server on a bad request: answer 500 and stay up.
      if (!response.headersSent) {
        sendJson(response, 500, { message: err instanceof Error ? err.message : String(err) }, requestId);
      } else {
        response.end();
      }
    }
  });
}
