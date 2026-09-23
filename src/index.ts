/**
 * Persistent interval index with snapshot-bound cursor pagination.
 *
 * The index is stored as a persistent (fully path-copying) AVL tree keyed by
 * the stable logical sort key (start, end, id). Every `add`/`remove` returns a
 * new snapshot and never mutates the previous one.
 *
 * A page cursor never references physical tree state (node paths / stack
 * indexes). It is bound to:
 *   - the root content identity (`revision`, a hash over the sorted key set)
 *   - the query range + direction fingerprint
 *   - the last returned stable sort key
 * Resuming validates the token, then the revision, then the query
 * fingerprint, and re-locates from the root by key. A wrong revision fails
 * explicitly with `StaleCursorError`; the caller must restart on the new
 * snapshot — continuation is never guessed.
 */

export interface Interval<V> {
  id: string;
  start: number;
  end: number;
  value: V;
}

export type Direction = 'asc' | 'desc';

export interface PageOptions {
  /** Query window start (inclusive-ish; overlap is half-open on each side). */
  start: number;
  /** Query window end. */
  end: number;
  /** Maximum items per page; must be a positive integer. */
  limit: number;
  /** Sort direction over the stable key (start, end, id). */
  direction?: Direction;
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
}

export interface Page<V> {
  items: Interval<V>[];
  /**
   * Non-null iff the page was full. Resuming it yields further rows or an
   * empty final page (when matched rows were an exact multiple of `limit`).
   */
  cursor: string | null;
}

/** Fingerprint of the logical query carried by a cursor. */
interface QueryFingerprint {
  s: number;
  e: number;
  d: Direction;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type CursorErrorCode =
  | 'INVALID_CURSOR'
  | 'STALE_CURSOR'
  | 'QUERY_MISMATCH';

export class CursorError extends Error {
  constructor(
    message: string,
    readonly code: CursorErrorCode,
  ) {
    super(message);
    this.name = 'CursorError';
  }
}

/** The cursor token is malformed, corrupted or tampered with. */
export class InvalidCursorError extends CursorError {
  constructor(message = 'invalid pagination cursor') {
    super(message, 'INVALID_CURSOR');
    this.name = 'InvalidCursorError';
  }
}

/** The cursor was issued against a different snapshot (root content). */
export class StaleCursorError extends CursorError {
  constructor(
    message = 'cursor was issued against a different index revision',
  ) {
    super(message, 'STALE_CURSOR');
    this.name = 'StaleCursorError';
  }
}

/** The cursor was issued for a different query range or direction. */
export class QueryMismatchError extends CursorError {
  constructor(message = 'cursor query range or direction does not match') {
    super(message, 'QUERY_MISMATCH');
    this.name = 'QueryMismatchError';
  }
}

/* -------------------------------------------------------------------------- */
/* Stable keys and hashing                                                    */
/* -------------------------------------------------------------------------- */

interface Key {
  id: string;
  start: number;
  end: number;
}

/** Total order shared by every query: start, then end, then id. */
function compareKey(a: Key, b: Key): number {
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  if (a.end < b.end) return -1;
  if (a.end > b.end) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** FNV-1a (32 bit) over a string. Deterministic across environments. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Order-independent hash of one key, summed into the root identity. */
function hashKey(k: Key): number {
  return (
    (fnv1a('' + k.start) ^ Math.imul(fnv1a('' + k.end), 0x9e3779b1)) ^
    Math.imul(fnv1a(k.id), 0x85ebca77)
  ) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Persistent AVL tree                                                        */
/* -------------------------------------------------------------------------- */

interface Node<V> extends Key {
  value: V;
  left: Node<V> | null;
  right: Node<V> | null;
  height: number;
  size: number;
  /** Sum of `hashKey` over the subtree; the root hash is shape independent. */
  hsum: number;
  /** Order-sensitive shape hash (left/right matter); internal/testing only. */
  shape: number;
}

function height<V>(n: Node<V> | null): number {
  return n === null ? 0 : n.height;
}

function sizeOf<V>(n: Node<V> | null): number {
  return n === null ? 0 : n.size;
}

function makeNode<V>(
  key: Key,
  value: V,
  left: Node<V> | null,
  right: Node<V> | null,
): Node<V> {
  // Order-sensitive mixing so a mirrored tree gets a different shape hash.
  const shape =
    (Math.imul(hashKey(key), 0x9e3779b9) ^
      Math.imul(left?.shape ?? 0x11111111, 0x01000193) ^
      Math.imul(right?.shape ?? 0x22222222, 0x85ebca6b)) >>>
    0;
  return {
    id: key.id,
    start: key.start,
    end: key.end,
    value,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
    size: 1 + sizeOf(left) + sizeOf(right),
    hsum: (hashKey(key) + ((left?.hsum ?? 0) + (right?.hsum ?? 0))) >>> 0,
    shape,
  };
}

function rotateLeft<V>(n: Node<V>): Node<V> {
  const r = n.right!;
  return makeNode(r, r.value, makeNode(n, n.value, n.left, r.left), r.right);
}

function rotateRight<V>(n: Node<V>): Node<V> {
  const l = n.left!;
  return makeNode(l, l.value, l.left, makeNode(n, n.value, l.right, n.right));
}

function rebalance<V>(n: Node<V>): Node<V> {
  const bf = height(n.left) - height(n.right);
  if (bf > 1) {
    const l = n.left!;
    if (height(l.left) - height(l.right) < 0) {
      n = makeNode(n, n.value, rotateLeft(l), n.right);
    }
    return rotateRight(n);
  }
  if (bf < -1) {
    const r = n.right!;
    if (height(r.left) - height(r.right) > 0) {
      n = makeNode(n, n.value, n.left, rotateRight(r));
    }
    return rotateLeft(n);
  }
  return n;
}

function insert<V>(n: Node<V> | null, key: Key, value: V): Node<V> {
  if (n === null) return makeNode(key, value, null, null);
  const c = compareKey(key, n);
  if (c < 0) {
    return rebalance(
      makeNode(n, n.value, insert(n.left, key, value), n.right),
    );
  }
  if (c > 0) {
    return rebalance(
      makeNode(n, n.value, n.left, insert(n.right, key, value)),
    );
  }
  // Duplicate logical key: replace the payload, identity is unchanged.
  return makeNode(key, value, n.left, n.right);
}

function removeMin<V>(
  n: Node<V>,
): { min: Node<V>; root: Node<V> | null } {
  if (n.left === null) return { min: n, root: n.right };
  const res = removeMin(n.left);
  return {
    min: res.min,
    root: rebalance(makeNode(n, n.value, res.root, n.right)),
  };
}

function erase<V>(n: Node<V> | null, key: Key): Node<V> | null {
  if (n === null) return null;
  const c = compareKey(key, n);
  if (c < 0) {
    return rebalance(makeNode(n, n.value, erase(n.left, key), n.right));
  }
  if (c > 0) {
    return rebalance(makeNode(n, n.value, n.left, erase(n.right, key)));
  }
  if (n.left === null) return n.right;
  if (n.right === null) return n.left;
  const { min, root } = removeMin(n.right);
  return rebalance(makeNode(min, min.value, n.left, root));
}

function collectKeysWithId<V>(
  n: Node<V> | null,
  id: string,
  out: Key[],
): void {
  if (n === null) return;
  collectKeysWithId(n.left, id, out);
  if (n.id === id) out.push({ id: n.id, start: n.start, end: n.end });
  collectKeysWithId(n.right, id, out);
}

/**
 * Ascending generator over nodes strictly greater than `after` (when given).
 * Traverses only the O(log n + k) relevant portion of the tree.
 */
function* ascend<V>(
  n: Node<V> | null,
  after: Key | null,
): Generator<Node<V>> {
  if (n === null) return;
  if (after === null) {
    yield* ascend(n.left, null);
    yield n;
    yield* ascend(n.right, null);
    return;
  }
  const c = compareKey(after, n);
  if (c < 0) {
    // after < n.key: n and its right side are candidates; descend left
    // to skip everything <= after.
    yield* ascend(n.left, after);
    yield n;
    yield* ascend(n.right, null);
  } else {
    // after >= n.key: n and its left side are behind us.
    yield* ascend(n.right, after);
  }
}

/** Descending generator over nodes strictly smaller than `before` (when given). */
function* descend<V>(
  n: Node<V> | null,
  before: Key | null,
): Generator<Node<V>> {
  if (n === null) return;
  if (before === null) {
    yield* descend(n.right, null);
    yield n;
    yield* descend(n.left, null);
    return;
  }
  const c = compareKey(before, n);
  if (c > 0) {
    // before > n.key: n and its left side are candidates; descend right
    // to skip everything >= before.
    yield* descend(n.right, before);
    yield n;
    yield* descend(n.left, null);
  } else {
    // before <= n.key: n and its right side are ahead of us.
    yield* descend(n.left, before);
  }
}

/* -------------------------------------------------------------------------- */
/* Opaque cursor encoding                                                     */
/* -------------------------------------------------------------------------- */

interface CursorData {
  v: 1;
  /** Root content identity this cursor is bound to. */
  rev: string;
  /** Query window + direction fingerprint. */
  q: QueryFingerprint;
  /** Last returned stable sort key (resume strictly past it). */
  k: Key;
}

const CURSOR_VERSION = 1;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Detects corruption/tampering of the cursor payload (not a security token). */
function checksum(payload: string): string {
  return fnv1a('interval-cursor:' + payload).toString(16).padStart(8, '0');
}

function encodeCursor(data: CursorData): string {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return payload + '.' + checksum(payload);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isKey(x: unknown): x is Key {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Key).id === 'string' &&
    isFiniteNumber((x as Key).start) &&
    isFiniteNumber((x as Key).end)
  );
}

function decodeCursor(token: string): CursorData {
  if (typeof token !== 'string') throw new InvalidCursorError();
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new InvalidCursorError();
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{8}$/.test(sig) || sig !== checksum(payload)) {
    throw new InvalidCursorError('cursor checksum mismatch');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { v?: unknown }).v !== CURSOR_VERSION
  ) {
    throw new InvalidCursorError('unsupported cursor version');
  }
  const d = raw as Partial<CursorData>;
  if (typeof d.rev !== 'string' || d.rev.length === 0) {
    throw new InvalidCursorError();
  }
  const q = d.q;
  if (
    typeof q !== 'object' ||
    q === null ||
    !isFiniteNumber((q as QueryFingerprint).s) ||
    !isFiniteNumber((q as QueryFingerprint).e) ||
    ((q as QueryFingerprint).d !== 'asc' &&
      (q as QueryFingerprint).d !== 'desc')
  ) {
    throw new InvalidCursorError();
  }
  if (!isKey(d.k)) throw new InvalidCursorError();
  return {
    v: CURSOR_VERSION,
    rev: d.rev,
    q: { s: q.s, e: q.e, d: q.d },
    k: { id: d.k.id, start: d.k.start, end: d.k.end },
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function assertFinite(name: string, x: number): void {
  if (!Number.isFinite(x)) throw new RangeError(`${name} must be finite`);
}

function assertItem(item: Interval<unknown>): void {
  if (
    item === null ||
    typeof item !== 'object' ||
    typeof item.id !== 'string' ||
    !Number.isFinite(item.start) ||
    !Number.isFinite(item.end) ||
    item.end < item.start
  ) {
    throw new Error('range');
  }
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

export class IntervalIndex<V> {
  /** Internal: persistent AVL root. Not part of the supported API. */
  private readonly root: Node<V> | null;

  constructor(items: Array<Interval<V>> = []) {
    let root: Node<V> | null = null;
    for (const item of items) {
      assertItem(item);
      root = insert(root, item, item.value);
    }
    this.root = root;
  }

  private static fromRoot<V>(root: Node<V> | null): IntervalIndex<V> {
    const index = Object.create(IntervalIndex.prototype) as IntervalIndex<V>;
    Object.defineProperty(index, 'root', { value: root });
    return index;
  }

  /**
   * Root content identity. Derived solely from the multiset of stored keys,
   * so it is stable across insert order and across AVL rotations, but changes
   * whenever the snapshot content changes.
   */
  get revision(): string {
    return (
      (this.root?.size ?? 0).toString(36) +
      '-' +
      (this.root?.hsum ?? 0).toString(36).padStart(7, '0')
    );
  }

  get size(): number {
    return sizeOf(this.root);
  }

  /** Internal: AVL height, useful to assert rotations keep the tree balanced. */
  get treeHeight(): number {
    return height(this.root);
  }

  /** Internal: order-sensitive physical shape hash (testing only). */
  get treeShape(): number {
    return this.root?.shape ?? 0;
  }

  add(item: Interval<V>): IntervalIndex<V> {
    assertItem(item);
    return IntervalIndex.fromRoot(insert(this.root, item, item.value));
  }

  remove(id: string): IntervalIndex<V> {
    const keys: Key[] = [];
    collectKeysWithId(this.root, id, keys);
    let root = this.root;
    for (const key of keys) root = erase(root, key);
    return IntervalIndex.fromRoot(root);
  }

  overlap(start: number, end: number): Array<Interval<V>> {
    assertFinite('start', start);
    assertFinite('end', end);
    const out: Array<Interval<V>> = [];
    for (const n of ascend(this.root, null)) {
      if (n.start < end && n.end > start) out.push(nodeToInterval(n));
    }
    return out;
  }

  /**
   * Stable, cursor-based window query.
   *
   * Resume order of checks (fail explicit, never guess):
   *   1. token integrity / tamper  -> InvalidCursorError
   *   2. snapshot root identity    -> StaleCursorError
   *   3. query range + direction   -> QueryMismatchError
   * Then re-locate from the root by the last returned stable sort key.
   */
  queryPage(options: PageOptions): Page<V> {
    const { start, end, limit } = options;
    const direction: Direction = options.direction ?? 'asc';
    assertFinite('start', start);
    assertFinite('end', end);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('limit must be a positive integer');
    }
    if (direction !== 'asc' && direction !== 'desc') {
      throw new RangeError("direction must be 'asc' or 'desc'");
    }

    let lastKey: Key | null = null;
    if (options.cursor !== undefined) {
      const data = decodeCursor(options.cursor);
      if (data.rev !== this.revision) throw new StaleCursorError();
      const q = data.q;
      if (q.s !== start || q.e !== end || q.d !== direction) {
        throw new QueryMismatchError();
      }
      lastKey = data.k;
    }

    const matches = (n: Node<V>): boolean =>
      n.start < end && n.end > start;

    const items: Array<Interval<V>> = [];
    const walk =
      direction === 'asc'
        ? ascend(this.root, lastKey)
        : descend(this.root, lastKey);

    // Keyset pagination: the cursor stores the last returned stable key.
    // A cursor is issued iff the page is full; resuming it yields either the
    // following rows (possibly after a rotation) or an empty final page when
    // the matched set was an exact multiple of the limit.
    for (const n of walk) {
      if (!matches(n)) continue;
      if (items.length === limit) break;
      items.push(nodeToInterval(n));
    }

    let cursor: string | null = null;
    if (items.length === limit) {
      const last = items[items.length - 1];
      cursor = encodeCursor({
        v: CURSOR_VERSION,
        rev: this.revision,
        q: { s: start, e: end, d: direction },
        k: { id: last.id, start: last.start, end: last.end },
      });
    }

    return { items, cursor };
  }
}

function nodeToInterval<V>(n: Node<V>): Interval<V> {
  return { id: n.id, start: n.start, end: n.end, value: n.value };
}
