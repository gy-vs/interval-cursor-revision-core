/**
 * Persistent interval index with snapshot-bound pagination cursors.
 *
 * A cursor never stores a mutable physical location (node path, stack index).
 * It stores:
 *   1. the root content identity (`revision`) of the immutable snapshot,
 *   2. a fingerprint of the query range and direction,
 *   3. the stable sort key of the last emitted result.
 *
 * On resume the fingerprint is verified, the revision must match the live
 * snapshot, and the walk relocates the key from the root. Tree rotations,
 * deletions and equal endpoints therefore cannot skip or repeat rows, and a
 * wrong revision fails explicitly instead of "guessing" a continuation.
 */

export type Interval<V> = { id: string; start: number; end: number; value: V };
export type Direction = 'asc' | 'desc';

export interface Page<V> {
  items: Interval<V>[];
  nextCursor: string | null;
}

export type CursorErrorCode =
  | 'INVALID_CURSOR'
  | 'UNSUPPORTED_CURSOR_VERSION'
  | 'STALE_REVISION'
  | 'QUERY_MISMATCH';

export class CursorError extends Error {
  constructor(
    readonly code: CursorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CursorError';
  }
}

// ---------------------------------------------------------------------------
// Persistent AVL tree, ordered by the stable total key (start, end, id).
// Every mutating operation copies the nodes on the affected path; rotations
// only rearrange pointers and never change logical content.
// ---------------------------------------------------------------------------

interface Node<V> {
  s: number;
  e: number;
  id: string;
  value: V;
  left: Node<V> | null;
  right: Node<V> | null;
  count: number;
  /** Deterministic min-heap priority derived from the key (see priority()). */
  prio: number;
  /** Structural content identity of this subtree. */
  hash: string;
}

type SortKey = readonly [s: number, e: number, id: string];

function cmpKey(a: SortKey, b: SortKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
}

// FNV-1a (32 bit), rendered as 8 hex chars. Content identity for subtrees and
// tamper checksum for cursors.
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashString(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}

const NULL_HASH = hashString('null');

// Treap priority is a pure function of the key, so the tree of any given
// content set is its unique Cartesian tree: inserting the same items in a
// different order performs different rotations but converges to the same
// shape. That makes the root hash a content identity, not a shape identity,
// while inserts/deletes still genuinely rotate nodes on every mutation.
function priority(key: SortKey): number {
  return fnv1a32(`${key[0]}/${key[1]}/${key[2]}`);
}

function refresh<V>(n: Node<V>): Node<V> {
  const lh = n.left ? n.left.hash : NULL_HASH;
  const rh = n.right ? n.right.hash : NULL_HASH;
  return {
    ...n,
    count: 1 + (n.left ? n.left.count : 0) + (n.right ? n.right.count : 0),
    hash: hashString(`(${lh})${n.s}|${n.e}|${n.id}|${JSON.stringify(n.value)}(${rh})`),
  };
}

function makeNode<V>(key: SortKey, value: V): Node<V> {
  return refresh({
    s: key[0],
    e: key[1],
    id: key[2],
    value,
    left: null,
    right: null,
    count: 1,
    prio: priority(key),
    hash: '',
  });
}

function rotateRight<V>(n: Node<V>): Node<V> {
  const l = n.left!;
  const down = refresh({ ...n, left: l.right });
  return refresh({ ...l, right: down });
}

function rotateLeft<V>(n: Node<V>): Node<V> {
  const r = n.right!;
  const down = refresh({ ...n, right: r.left });
  return refresh({ ...r, left: down });
}

// Persistent treap merge: all keys in a precede all keys in b.
function merge<V>(a: Node<V> | null, b: Node<V> | null): Node<V> | null {
  if (!a) return b;
  if (!b) return a;
  if (a.prio < b.prio) return refresh({ ...a, right: merge(a.right, b) });
  return refresh({ ...b, left: merge(a, b.left) });
}

function insert<V>(n: Node<V> | null, key: SortKey, value: V): Node<V> {
  if (!n) return makeNode(key, value);
  const c = cmpKey(key, [n.s, n.e, n.id]);
  if (c === 0) return refresh({ ...n, value });
  if (c < 0) {
    const withChild: Node<V> = { ...n, left: insert(n.left, key, value) };
    // Rotate the new (higher-priority) node up; otherwise just repaint.
    return withChild.left!.prio < n.prio ? rotateRight(withChild) : refresh(withChild);
  }
  const withChild: Node<V> = { ...n, right: insert(n.right, key, value) };
  return withChild.right!.prio < n.prio ? rotateLeft(withChild) : refresh(withChild);
}

function removeKey<V>(n: Node<V> | null, key: SortKey): Node<V> | null {
  if (!n) return null;
  const c = cmpKey(key, [n.s, n.e, n.id]);
  if (c < 0) return refresh({ ...n, left: removeKey(n.left, key) });
  if (c > 0) return refresh({ ...n, right: removeKey(n.right, key) });
  return merge(n.left, n.right);
}

function findById<V>(n: Node<V> | null, id: string): Node<V> | null {
  // Ids are unique, but the tree is ordered by (start, end, id), so this is a
  // plain subtree scan.
  if (!n) return null;
  if (n.id === id) return n;
  return findById(n.left, id) || findById(n.right, id);
}

function addInterval<V>(root: Node<V> | null, item: Interval<V>): Node<V> | null {
  if (!(item.end >= item.start)) throw new Error('range');
  let next = root;
  const existing = findById(next, item.id);
  if (existing) next = removeKey(next, [existing.s, existing.e, existing.id]);
  return insert(next, [item.start, item.end, item.id], item.value);
}

function toInterval<V>(n: Node<V>): Interval<V> {
  return { id: n.id, start: n.s, end: n.e, value: n.value };
}

// ---------------------------------------------------------------------------
// Snapshot retention. Deriving a new index never invalidates an old one: old
// roots stay reachable here, so cursors minted against old revisions keep
// working against those snapshots.
// ---------------------------------------------------------------------------

const retained = new Map<string, Node<unknown> | null>();

function retain<V>(root: Node<V> | null): string {
  const revision = root ? root.hash : NULL_HASH;
  retained.set(revision, root as Node<unknown>);
  return revision;
}

// ---------------------------------------------------------------------------
// Ordered overlap walks. They always start from the root and relocate the
// caller's stable key; there is no stored node pointer or stack index.
// ---------------------------------------------------------------------------

function overlaps(n: Node<unknown>, lo: number, hi: number): boolean {
  return n.s < hi && n.e > lo;
}

/** Ascending in-order walk, emitting nodes whose key is strictly after `after`
 * (null = beginning) and which overlap [lo, hi). */
function* ascOverlaps<V>(
  root: Node<V> | null,
  lo: number,
  hi: number,
  after: SortKey | null,
): Generator<Interval<V>> {
  const stack: Node<V>[] = [];
  let cur = root;
  for (;;) {
    while (cur) {
      if (!after || cmpKey([cur.s, cur.e, cur.id], after) >= 0) {
        stack.push(cur);
        cur = cur.left;
      } else {
        cur = cur.right;
      }
    }
    if (stack.length === 0) return;
    const n = stack.pop()!;
    // Everything later has start >= n.s; once that reaches hi no future
    // interval can overlap.
    if (n.s >= hi) return;
    if (!after || cmpKey([n.s, n.e, n.id], after) > 0) {
      if (overlaps(n, lo, hi)) yield toInterval(n);
    }
    cur = n.right;
  }
}

/** Descending reverse-order walk, emitting nodes whose key is strictly before
 * `before` (null = end). */
function* descOverlaps<V>(
  root: Node<V> | null,
  lo: number,
  hi: number,
  before: SortKey | null,
): Generator<Interval<V>> {
  const stack: Node<V>[] = [];
  let cur = root;
  for (;;) {
    while (cur) {
      if (!before || cmpKey([cur.s, cur.e, cur.id], before) <= 0) {
        stack.push(cur);
        cur = cur.right;
      } else {
        cur = cur.left;
      }
    }
    if (stack.length === 0) return;
    const n = stack.pop()!;
    if (!before || cmpKey([n.s, n.e, n.id], before) < 0) {
      if (overlaps(n, lo, hi)) yield toInterval(n);
    }
    cur = n.left;
  }
}

function take<T>(gen: Generator<T>, n: number): T[] {
  const out: T[] = [];
  for (const x of gen) {
    out.push(x);
    if (out.length === n) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opaque cursor token: base64url(JSON) with a content checksum.
// {v:1, r:revision, q:[lo,hi], d:'a'|'d', k:[s,e,id]|null, c:checksum}
// ---------------------------------------------------------------------------

type RawToken = {
  v: number;
  r: string;
  q: [number, number];
  d: 'a' | 'd';
  k: SortKey | null;
  c: string;
};

function checksum(t: Omit<RawToken, 'v' | 'c'>): string {
  return hashString([t.r, t.q[0], t.q[1], t.d, t.k ? t.k.join('/') : ''].join('|'));
}

function encodeToken(
  revision: string,
  lo: number,
  hi: number,
  direction: Direction,
  key: SortKey | null,
): string {
  const body = {
    r: revision,
    q: [lo, hi] as [number, number],
    d: direction === 'asc' ? ('a' as const) : ('d' as const),
    k: key,
  };
  const t: RawToken = { v: 1, ...body, c: checksum(body) };
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}

function isSortKey(x: unknown): x is SortKey {
  return (
    Array.isArray(x) &&
    x.length === 3 &&
    typeof x[0] === 'number' &&
    Number.isFinite(x[0]) &&
    typeof x[1] === 'number' &&
    Number.isFinite(x[1]) &&
    typeof x[2] === 'string'
  );
}

function decodeToken(token: string): RawToken {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('INVALID_CURSOR', 'cursor is not a valid token');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new CursorError('INVALID_CURSOR', 'cursor payload is not an object');
  }
  const t = raw as Record<string, unknown>;
  if (t.v !== 1) {
    throw new CursorError(
      'UNSUPPORTED_CURSOR_VERSION',
      `unsupported cursor version: ${String(t.v)}`,
    );
  }
  if (
    typeof t.r !== 'string' ||
    !Array.isArray(t.q) ||
    t.q.length !== 2 ||
    typeof t.q[0] !== 'number' ||
    typeof t.q[1] !== 'number' ||
    (t.d !== 'a' && t.d !== 'd') ||
    (t.k !== null && !isSortKey(t.k)) ||
    typeof t.c !== 'string'
  ) {
    throw new CursorError('INVALID_CURSOR', 'cursor payload is malformed');
  }
  const parsed = raw as RawToken;
  if (parsed.c !== checksum(parsed)) {
    throw new CursorError('INVALID_CURSOR', 'cursor checksum does not match');
  }
  return parsed;
}

// ---------------------------------------------------------------------------

export class IntervalIndex<V> {
  private readonly root: Node<V> | null;
  /** Root content identity this snapshot (and its cursors) are bound to. */
  readonly revision: string;

  constructor(items: Interval<V>[] = []) {
    let root: Node<V> | null = null;
    for (const item of items) root = addInterval(root, item);
    this.root = root;
    this.revision = retain(root);
  }

  private static fromRoot<V>(root: Node<V> | null): IntervalIndex<V> {
    const index = Object.create(IntervalIndex.prototype) as IntervalIndex<V>;
    Object.assign(index as unknown as { root: Node<V> | null; revision: string }, {
      root,
      revision: retain(root),
    });
    return index;
  }

  add(item: Interval<V>): IntervalIndex<V> {
    return IntervalIndex.fromRoot(addInterval(this.root, item));
  }

  remove(id: string): IntervalIndex<V> {
    const existing = findById(this.root, id);
    if (!existing) return this;
    return IntervalIndex.fromRoot(
      removeKey(this.root, [existing.s, existing.e, existing.id]),
    );
  }

  size(): number {
    return this.root ? this.root.count : 0;
  }

  overlap(start: number, end: number): Interval<V>[] {
    return [...ascOverlaps(this.root, start, end, null)];
  }

  /**
   * One page of an overlap query. Pass `null`/`undefined` cursor for the first
   * page; pass `Page.nextCursor` for the next one. The cursor is bound to this
   * snapshot's revision and to the exact (range, direction) pair: any drift
   * fails with a {@link CursorError} rather than silently skipping or
   * repeating rows.
   */
  overlapPage(
    start: number,
    end: number,
    pageSize: number,
    cursor: string | null | undefined,
    direction: Direction = 'asc',
  ): Page<V> {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TypeError('overlap range must be finite numbers');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new TypeError('pageSize must be a positive integer');
    }

    let anchor: SortKey | null = null;
    if (cursor !== null && cursor !== undefined) {
      const token = decodeToken(cursor);
      if (
        token.q[0] !== start ||
        token.q[1] !== end ||
        (token.d === 'a' ? 'asc' : 'desc') !== direction
      ) {
        throw new CursorError(
          'QUERY_MISMATCH',
          'cursor was created for a different query range or direction',
        );
      }
      if (token.r !== this.revision) {
        throw new CursorError(
          'STALE_REVISION',
          `cursor revision ${token.r} does not match snapshot ${this.revision}`,
        );
      }
      if (!retained.has(this.revision)) {
        throw new CursorError(
          'STALE_REVISION',
          `snapshot ${this.revision} is no longer retained`,
        );
      }
      anchor = token.k;
    }

    // Fetch one extra row to decide exact termination, so the final page is
    // always followed by nextCursor === null (no trailing empty round trip).
    const gen =
      direction === 'asc'
        ? ascOverlaps(this.root, start, end, anchor)
        : descOverlaps(this.root, start, end, anchor);
    const got = take(gen, pageSize + 1);
    const items = got.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor =
      got.length > pageSize && last
        ? encodeToken(this.revision, start, end, direction, [
            last.start,
            last.end,
            last.id,
          ])
        : null;
    return { items, nextCursor };
  }

  /** Whether an old snapshot's root is still retained for cursor resume. */
  static isSnapshotRetained(revision: string): boolean {
    return retained.has(revision);
  }

  /** Opt-in cleanup; by default every old snapshot stays retained. */
  static releaseSnapshot(revision: string): void {
    retained.delete(revision);
  }
}
