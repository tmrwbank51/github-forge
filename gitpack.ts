// The git object model and packfile format, dependency-free.
//
// Everything here is the plain git on-disk format as the protocol documents it:
// objects are `<type> <size>\0` + bytes hashed with SHA-1; trees are mode/name/oid
// records in git's sort order; packfiles are a PACK header, type/size varint
// entries with zlib bodies, and a SHA-1 trailer. Deltas (OFS_DELTA / REF_DELTA)
// resolve against the pack itself or a caller-supplied base lookup, so thin
// packs a fetch negotiates can be read too. No git binary, no clock, no
// randomness: every function here is a pure function of its inputs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

/** SHA-1 over the loose-object framing `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order, with a directory's name compared as if suffixed with '/'. */
function treeOrder(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeOrder);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitInfo {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagInfo {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error('tag has an unknown target type');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** The exact bytes of a commit object. The message is stored verbatim (no newline added). */
export function buildCommitBytes(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// deltas
// ---------------------------------------------------------------------------------------------

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) copyOffset += deltaBuffer[offset++] * 2 ** (bit * 8);
      }
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) copySize += deltaBuffer[offset++] * 2 ** ((bit - 4) * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length || written + copySize > targetSize) {
        throw new Error('delta copy is out of range');
      }
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length || written + literal > targetSize) {
        throw new Error('delta insert is out of range');
      }
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

function readPackEntryHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past the stream. */
function inflateOne(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA entries. A REF_DELTA
 * whose base is not in the pack is resolved through `resolveBase` (a thin pack's bases live
 * in the caller's store). The trailer checksum is verified; every object's id is recomputed.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateOne(buffer, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Order is the caller's; the trailer is SHA-1. */
export function writePack(objects: Iterable<{ type: ObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(packEntryHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// reachability, ancestry, shallow boundaries
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`, with an optional commit-depth limit. A commit at
 * distance `d` from a root is included when `depth` is null or `d < depth`; trees and
 * blobs of included commits are always included whole. `boundary` holds the included
 * commits at the depth edge whose parents were cut off (the shallow-info lines).
 * Traversal never descends past `stopAt` commits (a shallow clone's held boundary).
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { depth?: number | null; stopAt?: ReadonlySet<string> } = {},
): { objects: Set<string>; boundary: Set<string>; commitDepth: Map<string, number> } {
  const depth = options.depth ?? null;
  const stopAt = options.stopAt ?? new Set<string>();
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  // Work items: [oid, commit distance or -1 for non-commit traversal]. A tag's target
  // inherits the tag's distance; a commit's tree/blobs are distance-free.
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const root of roots) {
    if (isOid(root)) queue.push({ oid: root, distance: 0 });
  }
  const seenNonCommit = new Set<string>();
  while (queue.length > 0) {
    const item = queue.pop()!;
    const object = lookup(item.oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const known = commitDepth.get(item.oid);
      if (known !== undefined && known <= item.distance) continue;
      if (depth !== null && item.distance >= depth) continue;
      commitDepth.set(item.oid, item.distance);
      objects.add(item.oid);
      if (stopAt.has(item.oid)) continue;
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, distance: -1 });
      for (const parent of commit.parents) {
        if (depth === null || item.distance + 1 < depth) {
          queue.push({ oid: parent, distance: item.distance + 1 });
        }
      }
    } else if (object.type === 'tag') {
      if (seenNonCommit.has(item.oid)) continue;
      seenNonCommit.add(item.oid);
      objects.add(item.oid);
      const tag = parseTag(object.data);
      queue.push({ oid: tag.object, distance: item.distance < 0 ? 0 : item.distance });
    } else if (object.type === 'tree') {
      if (seenNonCommit.has(item.oid)) continue;
      seenNonCommit.add(item.oid);
      objects.add(item.oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, distance: -1 });
      }
    } else {
      if (seenNonCommit.has(item.oid)) continue;
      seenNonCommit.add(item.oid);
      objects.add(item.oid);
    }
  }
  // The shallow boundary, computed after the walk settles every commit's shortest
  // distance: every included commit at the depth edge, whether or not it has
  // parents (git marks a root commit at the edge shallow too).
  if (depth !== null) {
    for (const [oid, distance] of commitDepth) {
      if (distance === depth - 1) boundary.add(oid);
    }
  }
  return { objects, boundary, commitDepth };
}

/** True when `ancestor` is reachable from `descendant` following commit parents (or equal). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (first found walking from `a` over `b`'s ancestors). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
  }
  const seen = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (ancestorsOfB.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
  }
  return null;
}

/** Peel tag objects to the first non-tag target (a commit for annotated release tags). */
export function peelToNonTag(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}
