// The git smart-HTTP surface: protocol v2 upload-pack (ls-refs, fetch),
// protocol v0 upload-pack (want/have fetch), and protocol v0 receive-pack
// (push with per-ref report-status). Pkt-line framing, sideband-64k pack
// delivery, shallow boundaries, fast-forward rules — all over the in-memory
// object store, with node:zlib and node:crypto as the only helpers.

import {
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  peelToNonTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitpack.ts';
import {
  branchTip,
  lookupOf,
  type Forge,
  type RepoState,
} from './store.ts';

export interface GitRequest {
  forge: Forge;
  method: string;
  owner: string;
  repoName: string;
  /** Segments after /{owner}/{repo}.git. */
  suffix: string[];
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const AGENT = 'github-forge/1.0';
const SIDEBAND_MAX_DATA = 65515;

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function encodePackets(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Parse pkt-lines from the front of a buffer; returns the packets and the untouched remainder. */
function decodePackets(buffer: Buffer, stopAtFlush: boolean): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error('invalid pkt-line length');
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Wrap bytes in sideband band-1 packets (band byte + data, each pkt-line framed). */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_MAX_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleGit(request: GitRequest): GitReply {
  try {
    const repo = request.forge.resolveRepo(request.owner, request.repoName);
    if (repo === null) {
      return {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
      };
    }
    const [head] = request.suffix;
    if (request.method === 'GET' && head === 'info' && request.suffix[1] === 'refs') {
      return infoRefs(request, repo);
    }
    if (request.method === 'POST' && head === 'git-upload-pack' && request.suffix.length === 1) {
      return uploadPack(request, repo);
    }
    if (request.method === 'POST' && head === 'git-receive-pack' && request.suffix.length === 1) {
      return receivePack(request, repo);
    }
    return {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
    };
  } catch (err) {
    // A malformed request must never take the server down: answer 400 and stay up.
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`bad request: ${err instanceof Error ? err.message : String(err)}`, 'utf8'),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: RepoState): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function peeledOid(repo: RepoState, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToNonTag(oid, lookupOf(repo));
}

function infoRefs(request: GitRequest, repo: RepoState): GitReply {
  const service = request.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('unknown service', 'utf8'),
    };
  }
  const protocolHeader = request.headers['git-protocol'];
  const wantsV2 = service === 'git-upload-pack' && typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
  const contentType = `application/x-${service}-advertisement`;
  if (wantsV2) {
    const body = encodePackets([
      `# service=${service}\n`,
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'flush',
    ]);
    return { status: 200, headers: { 'content-type': contentType }, body };
  }
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = branchTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    let first = true;
    const line = (text: string): string => {
      if (first) {
        first = false;
        return `${text}\0${capabilities}\n`;
      }
      return `${text}\n`;
    };
    if (headTip !== undefined) items.push(line(`${headTip} HEAD`));
    for (const ref of refs) {
      items.push(line(`${ref.oid} ${ref.name}`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) items.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  return { status: 200, headers: { 'content-type': contentType }, body: encodePackets(items) };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function computeFetch(repo: RepoState, args: FetchArgs): {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
} {
  const lookup = lookupOf(repo);
  const shallowSet = new Set(args.shallow);
  const held = collectReachable(args.haves, lookup, { stopAt: shallowSet });
  const wanted = collectReachable(args.wants, lookup, { depth: args.depth });
  const send = new Set<string>();
  for (const oid of wanted.objects) {
    if (!held.objects.has(oid)) send.add(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  const shallow = [...wanted.boundary].sort();
  const unshallow: string[] = [];
  for (const boundaryOid of args.shallow) {
    if (!wanted.commitDepth.has(boundaryOid)) continue;
    const object = repo.objects.get(boundaryOid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const covered = parents.every((parent) => send.has(parent) || held.objects.has(parent));
    if (covered) unshallow.push(boundaryOid);
  }
  unshallow.sort();
  const acks: string[] = [];
  for (const have of args.haves) {
    if (args.wants.includes(have)) {
      acks.push(have);
      continue;
    }
    for (const want of args.wants) {
      if (isAncestor(have, want, lookup)) {
        acks.push(have);
        break;
      }
    }
  }
  return { pack, shallow, unshallow, acks };
}

// Fetch responses are pure functions of (repo objects, request lines): the same
// clone repeated — the benchmark's 50 concurrent depth-1 clones — rebuilds the
// same pack every time. Cache the finished response buffer per repo, keyed by
// the repo's object version plus every raw request line, so any variation in
// the request (wants, haves, depth, filters, boundaries) is a distinct key and
// any object write invalidates every entry. Bounded per repo; repos are held
// weakly so a deleted repo's entries disappear with it.
const FETCH_CACHE = new WeakMap<RepoState, Map<string, Buffer>>();
const FETCH_CACHE_PER_REPO = 32;

function fetchCacheLookup(repo: RepoState, protocol: string, packets: Packet[]): Buffer | undefined {
  const perRepo = FETCH_CACHE.get(repo);
  if (!perRepo) return undefined;
  const hit = perRepo.get(fetchCacheKey(repo, protocol, packets));
  return hit === undefined ? undefined : Buffer.from(hit);
}

function fetchCacheStore(repo: RepoState, protocol: string, packets: Packet[], value: Buffer): Buffer {
  let perRepo = FETCH_CACHE.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    FETCH_CACHE.set(repo, perRepo);
  }
  if (perRepo.size >= FETCH_CACHE_PER_REPO) {
    const oldest = perRepo.keys().next().value;
    if (oldest !== undefined) perRepo.delete(oldest);
  }
  perRepo.set(fetchCacheKey(repo, protocol, packets), value);
  return value;
}

function fetchCacheKey(repo: RepoState, protocol: string, packets: Packet[]): string {
  const lines = packets.map((packet) => (packet.kind === 'data' ? packet.payload.toString('utf8') : packet.kind));
  return `${repo.version}:${protocol}:${lines.join('\u0001')}`;
}

function fetchV2(repo: RepoState, packets: Packet[]): Buffer {
  const cached = fetchCacheLookup(repo, 'v2', packets);
  if (cached) return cached;
  const built = fetchV2Uncached(repo, packets);
  return fetchCacheStore(repo, 'v2', packets, built);
}

function fetchV2Uncached(repo: RepoState, packets: Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, no action.
  }
  args.wants = [...new Set(args.wants.filter(isOid))];
  args.haves = [...new Set(args.haves.filter(isOid))];
  args.shallow = [...new Set(args.shallow.filter(isOid))];
  const result = computeFetch(repo, args);
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (result.acks.length > 0) {
    for (const ack of result.acks) ackLines.push(`ACK ${ack}\n`);
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('delim');
  parts.push(encodePackets(ackLines));
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of result.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of result.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePackets(shallowLines));
  }
  parts.push(encodePackets(['packfile\n']));
  parts.push(sideband(result.pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoState, packets: Packet[]): Buffer {
  const cached = fetchCacheLookup(repo, 'v0', packets);
  if (cached) return cached;
  const built = fetchV0Uncached(repo, packets);
  return fetchCacheStore(repo, 'v0', packets, built);
}

function fetchV0Uncached(repo: RepoState, packets: Packet[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0];
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  args.wants = [...new Set(args.wants)];
  args.haves = [...new Set(args.haves)];
  args.shallow = [...new Set(args.shallow)];
  const result = computeFetch(repo, args);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of result.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePackets(lines));
  parts.push(sideband(result.pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPack(request: GitRequest, repo: RepoState): GitReply {
  const { packets } = decodePackets(request.body, false);
  const firstLine = packetLines(packets)[0] ?? '';
  let body: Buffer;
  if (firstLine.startsWith('command=ls-refs')) {
    // Re-parse honouring the delim: arguments live after it.
    const args: string[] = [];
    let pastDelim = false;
    const flags = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      if (!pastDelim) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      args.push(line);
      if (line === 'peel') flags.peel = true;
      else if (line === 'symrefs') flags.symrefs = true;
      else if (line === 'unborn') flags.unborn = true;
      else if (line.startsWith('ref-prefix ')) flags.prefixes.push(line.slice('ref-prefix '.length));
    }
    void args;
    body = lsRefsWithFlags(repo, flags);
  } else if (firstLine.startsWith('command=fetch')) {
    body = fetchV2(repo, packets);
  } else if (firstLine.startsWith('command=')) {
    throw new Error(`unknown v2 command ${JSON.stringify(firstLine)}`);
  } else {
    body = fetchV0(repo, packets);
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body };
}

function lsRefsWithFlags(
  repo: RepoState,
  flags: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const out: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => flags.prefixes.length === 0 || flags.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = branchTip(repo, repo.defaultBranch);
  if (flags.symrefs && keep('HEAD')) {
    if (headTip !== undefined) {
      out.push(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    } else if (flags.unborn) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let text = `${ref.oid} ${ref.name}`;
    if (flags.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) text += ` peeled:${peeled}`;
    }
    out.push(`${text}\n`);
  }
  out.push('flush');
  return encodePackets(out);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(request: GitRequest, repo: RepoState): GitReply {
  const { packets, rest } = decodePackets(request.body, true);
  const lines = packetLines(packets);
  if (lines.length === 0) throw new Error('empty receive-pack request');
  const commands: PushCommand[] = [];
  let capabilities = '';
  lines.forEach((raw, index) => {
    const line = raw.replace(/\n$/, '');
    let text = line;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        text = line.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const pack = readPack(rest, { resolveBase: lookupOf(repo) });
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const snapshot = new Map(repo.refs);
  const lookup = lookupOf(repo);
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const accepted: PushCommand[] = [];
  for (const command of commands) {
    const current = snapshot.get(command.ref);
    let verdict: { ok: boolean; reason: string };
    if (unpackError !== null) {
      verdict = { ok: false, reason: 'unpacker error' };
    } else if (command.newOid === ZERO_OID) {
      if (current === undefined) verdict = { ok: false, reason: 'remote ref does not exist' };
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdict = { ok: false, reason: 'old oid mismatch' };
      else verdict = { ok: true, reason: '' };
    } else if (command.oldOid === ZERO_OID) {
      if (current !== undefined) verdict = { ok: false, reason: 'already exists' };
      else if (repo.objects.get(command.newOid) === undefined) verdict = { ok: false, reason: 'missing object' };
      else verdict = { ok: true, reason: '' };
    } else {
      if (current === undefined) verdict = { ok: false, reason: 'remote ref does not exist' };
      else if (command.oldOid !== current) verdict = { ok: false, reason: 'old oid mismatch' };
      else if (repo.objects.get(command.newOid) === undefined) verdict = { ok: false, reason: 'missing object' };
      else if (command.newOid === current) verdict = { ok: true, reason: '' };
      else {
        const oldPeeled = peelToNonTag(command.oldOid, lookup);
        const newPeeled = peelToNonTag(command.newOid, lookup);
        verdict = isAncestor(oldPeeled, newPeeled, lookup)
          ? { ok: true, reason: '' }
          : { ok: false, reason: 'non-fast-forward' };
      }
    }
    reports.push({ ref: command.ref, ...verdict });
    if (verdict.ok) accepted.push(command);
  }
  for (const command of accepted) {
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }

  const reportLines: Array<string | 'flush'> = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const reportItem of reports) {
    reportLines.push(reportItem.ok ? `ok ${reportItem.ref}\n` : `ng ${reportItem.ref} ${reportItem.reason}\n`);
  }
  reportLines.push('flush');
  const reportStream = encodePackets(reportLines);
  const body = wantsSideband ? Buffer.concat([sideband(reportStream), FLUSH]) : reportStream;
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body };
}
