# Persistent interval index

TypeScript library for interval storage and stable cursor-paginated queries.

Run `npm install`, then `npm test` and `npm run build`.

## Model

- The index is a **persistent AVL tree** keyed by the total order
  `(start, end, id)`. `add` / `remove` return new snapshots and never mutate
  previous ones; insertions and deletions rotate via path copying.
- `index.revision` is the **root content identity**: a hash over the multiset
  of stored keys. It is independent of insertion order and physical tree
  shape, and changes exactly when content changes.

## Pagination

```ts
const page = index.queryPage({ start: 0, end: 10, limit: 20 });
const next = index.queryPage({ start: 0, end: 10, limit: 20, cursor: page.cursor! });
```

Cursors are opaque tokens (base64url payload + checksum) that contain **no
physical state** (no node paths / stack indexes). They bind:

1. the root content identity (`revision`),
2. the query fingerprint (window `start`/`end` and direction),
3. the last returned stable sort key.

On resume the token is verified, then the revision, then the query
fingerprint; reading then **re-locates from the root by stable key**, so
rotations between pages can never skip or duplicate rows. A cursor is issued
iff the page is full; resuming it after the final full page returns an empty
page with `cursor: null` (when matches are an exact multiple of `limit`).

Errors are explicit — continuation is never guessed:

- `InvalidCursorError` — malformed/corrupted/tampered token,
- `StaleCursorError` — cursor belongs to a different `revision`; restart the
  query on the new snapshot,
- `QueryMismatchError` — window or direction differs from the cursor's
  fingerprint.

Old snapshots remain valid: a cursor issued by an older snapshot keeps
working on that snapshot even after newer revisions exist.
