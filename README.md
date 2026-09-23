# Persistent interval index

TypeScript library for interval storage and overlap queries, with
**snapshot-bound pagination cursors** that are safe across tree rotations,
inserts and deletes.

Run `npm install`, then `npm test` and `npm run build`.

## Data structure

- Persistent (path-copying) **treap**, keyed by the stable total order
  `(start, end, id)`. Every `add`/`remove` returns a new index; old snapshots
  remain readable.
- Node priorities are derived deterministically from the key. Inserting the
  same content in any order performs rotations but converges to the same tree,
  so the **revision is a content identity**, independent of physical shape.
- `revision` is a structural hash (FNV-1a) of the root's content. Rotations
  within an unchanged set preserve it; any insert, delete or value change
  changes it.

## Pagination cursors

A cursor is an opaque base64url token containing **no physical location** (no
node path, no stack index). It stores:

1. `revision` — root content identity the cursor is bound to,
2. query fingerprint — the exact `(start, end, direction)`,
3. the stable sort key `(start, end, id)` of the last returned result.

On resume:

- the range/direction fingerprint is checked (`QUERY_MISMATCH` on drift);
- the revision must match the queried snapshot (`STALE_REVISION` otherwise —
  it never guesses a continuation on another snapshot);
- the walk **relocates the key from the root**, so rotations, deleted rows and
  duplicate endpoints cannot skip or repeat items;
- the token carries a checksum; any tampering is rejected
  (`INVALID_CURSOR` / `UNSUPPORTED_CURSOR_VERSION`).

Old snapshots are retained by default, so a cursor minted against an old
revision keeps working against that old index after newer versions were
derived. Use `IntervalIndex.releaseSnapshot(revision)` for opt-in cleanup.

## API

```ts
const idx = new IntervalIndex<number>()
  .add({ id: 'a', start: 1, end: 3, value: 1 });

idx.revision;            // content identity of this snapshot
idx.overlap(2, 4);       // one-shot query, sorted by (start, end, id)

const page1 = idx.overlapPage(2, 4, 10, null);        // first page
const page2 = idx.overlapPage(2, 4, 10, page1.nextCursor);
// descending: last arg 'desc'; nextCursor === null means exhausted
// (an empty result is a single empty page with nextCursor === null).

const next = idx.add({ id: 'b', start: 2, end: 5, value: 2 });
next.overlapPage(2, 4, 10, page1.nextCursor);
// -> throws CursorError { code: 'STALE_REVISION' }
```

Paging invariant, for any snapshot, range, page size and direction:

> concatenating all pages equals one full `overlap` query in that direction.
