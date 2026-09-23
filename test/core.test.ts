import { describe, expect, it } from 'vitest';
import { CursorError, IntervalIndex, Interval } from '../src/index.js';

const pad = (n: number) => String(n).padStart(4, '0');

function intervals(n: number): Interval<number>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: pad(i),
    start: i % 10,
    end: (i % 10) + 5,
    value: i,
  }));
}

/** Drain every page of a paged query and concatenate the items. */
function drain<V>(
  index: IntervalIndex<V>,
  start: number,
  end: number,
  pageSize: number,
  direction: 'asc' | 'desc' = 'asc',
): { items: Interval<V>[]; pages: number } {
  const out: Interval<V>[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = index.overlapPage(start, end, pageSize, cursor, direction);
    out.push(...page.items);
    pages++;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    if (pages > 1000) throw new Error('pagination did not terminate');
  }
  return { items: out, pages };
}

function tamper(cursor: string, mutate: (json: any) => void): string {
  const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  mutate(json);
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
}

describe('existing API', () => {
  it('queries', () =>
    expect(
      new IntervalIndex<number>().add({ id: 'a', start: 1, end: 3, value: 1 }).overlap(2, 4),
    ).toHaveLength(1));

  it('rejects inverted ranges on add', () =>
    expect(() =>
      new IntervalIndex<number>().add({ id: 'a', start: 5, end: 4, value: 1 }),
    ).toThrow('range'));

  it('remove of an unknown id keeps the same snapshot identity', () => {
    const index = new IntervalIndex<number>(intervals(10));
    expect(index.remove('nope')).toBe(index);
  });
});

describe('rotation / fixed-snapshot pagination', () => {
  // Monotonic inserts force many AVL rotations; with pageSize 1 every result
  // sits on a page boundary, which is exactly where path/stack-style cursors
  // skip or repeat after structural rearrangement.
  for (const pageSize of [1, 2, 7, 100]) {
    it(`paged concat equals one-shot query (pageSize ${pageSize}, asc)`, () => {
      const index = new IntervalIndex<number>(intervals(80));
      const full = index.overlap(2, 8);
      const { items, pages } = drain(index, 2, 8, pageSize);
      expect(items).toEqual(full);
      expect(pages).toBe(Math.ceil(full.length / pageSize) + (full.length ? 0 : 1) || 1);
    });

    it(`paged concat equals one-shot query (pageSize ${pageSize}, desc)`, () => {
      const index = new IntervalIndex<number>(intervals(80));
      const full = index.overlap(2, 8).reverse();
      expect(drain(index, 2, 8, pageSize, 'desc').items).toEqual(full);
    });
  }

  it('never repeats or skips across pages, ascending and descending', () => {
    const index = new IntervalIndex<number>(intervals(80));
    for (const direction of ['asc', 'desc'] as const) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = index.overlapPage(2, 8, 3, cursor, direction);
        for (const item of page.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.size).toBe(index.overlap(2, 8).length);
    }
  });

  it('content identity ignores physical shape: differently rotated trees share revision and cursors', () => {
    const base = Array.from({ length: 50 }, (_, i) => ({
      id: pad(i),
      start: i,
      end: i + 3,
      value: i,
    }));
    const asc = new IntervalIndex<number>(base);
    const desc = new IntervalIndex<number>([...base].reverse());
    const shuffled = new IntervalIndex<number>([
      ...base.filter((_, i) => i % 2 === 0),
      ...base.filter((_, i) => i % 2 === 1),
    ]);

    // Same logical content => identical revision even though insertion order
    // (and therefore the rotations performed) differed.
    expect(desc.revision).toBe(asc.revision);
    expect(shuffled.revision).toBe(asc.revision);

    // A cursor minted against one physical shape resumes correctly against
    // another shape with the same content identity.
    const first = asc.overlapPage(10, 40, 4, null);
    const fromOtherShape = desc.overlapPage(10, 40, 4, first.nextCursor);
    const expected = drain(shuffled, 10, 40, 4).items;
    const stitched = [...first.items, ...drainFrom(desc, 10, 40, 4, first.nextCursor!)];
    expect(stitched).toEqual(expected);
    expect(fromOtherShape.items.length).toBeGreaterThan(0);
  });

  function drainFrom<V>(
    index: IntervalIndex<V>,
    start: number,
    end: number,
    pageSize: number,
    cursor: string,
  ): Interval<V>[] {
    const out: Interval<V>[] = [];
    let cur: string | null = cursor;
    while (cur) {
      const page = index.overlapPage(start, end, pageSize, cur);
      out.push(...page.items);
      cur = page.nextCursor;
    }
    return out;
  }

  it('old cursor survives rotations caused by later inserts when resumed on its own snapshot', () => {
    const a = new IntervalIndex<number>(intervals(30));
    const first = a.overlapPage(0, 20, 5, null);

    // Derived snapshots undergo many rotations; the old snapshot is immutable.
    let b = a;
    for (let i = 100; i < 160; i++) {
      b = b.add({ id: pad(i), start: i % 10, end: (i % 10) + 8, value: i });
    }
    expect(b.revision).not.toBe(a.revision);

    // Resume the old cursor on the old snapshot: no skip, no repeat.
    let items = [...first.items];
    let cur = first.nextCursor;
    while (cur) {
      const page = a.overlapPage(0, 20, 5, cur);
      items.push(...page.items);
      cur = page.nextCursor;
    }
    expect(items).toEqual(a.overlap(0, 20));

    // The same cursor must not be "guessed" onto the changed snapshot.
    expect(() => b.overlapPage(0, 20, 5, first.nextCursor)).toThrowError(
      CursorError,
    );
    try {
      b.overlapPage(0, 20, 5, first.nextCursor);
    } catch (e) {
      expect((e as CursorError).code).toBe('STALE_REVISION');
    }
  });
});

describe('deleting the last item', () => {
  it('cursor from before the delete still completes on the retained old snapshot', () => {
    const a = new IntervalIndex<number>(intervals(40));
    const full = a.overlap(2, 8);
    const first = a.overlapPage(2, 8, 4, null);

    const lastId = full[full.length - 1].id;
    const b = a.remove(lastId);
    expect(b.revision).not.toBe(a.revision);

    // Continue on old snapshot: reaches the deleted-from-b row fine.
    const rest: Interval<number>[] = [];
    let cur = first.nextCursor;
    while (cur) {
      const page = a.overlapPage(2, 8, 4, cur);
      rest.push(...page.items);
      cur = page.nextCursor;
    }
    expect([...first.items, ...rest]).toEqual(full);

    // Old cursor explicitly fails on the new snapshot.
    expect(() => b.overlapPage(2, 8, 4, first.nextCursor)).toThrowError(CursorError);

    // New snapshot pagination agrees with its own one-shot query.
    expect(drain(b, 2, 8, 3).items).toEqual(b.overlap(2, 8));
    expect(b.overlap(2, 8).find((x) => x.id === lastId)).toBeUndefined();
  });

  it('deleting the only matching item yields an empty page with null cursor', () => {
    const index = new IntervalIndex<number>([
      { id: 'x', start: 5, end: 6, value: 1 },
      { id: 'y', start: 100, end: 101, value: 2 },
    ]);
    const trimmed = index.remove('x');
    const page = trimmed.overlapPage(0, 50, 10, null);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('anchor still relocates when the row at the anchor position was removed', () => {
    // On the old snapshot, page1 ends at id D. On the new snapshot D is gone;
    // restarting pagination from scratch on the new snapshot is gap-free.
    const index = new IntervalIndex<number>([
      { id: 'a', start: 1, end: 9, value: 1 },
      { id: 'b', start: 2, end: 9, value: 1 },
      { id: 'c', start: 3, end: 9, value: 1 },
      { id: 'd', start: 4, end: 9, value: 1 },
      { id: 'e', start: 5, end: 9, value: 1 },
    ]);
    const first = index.overlapPage(0, 10, 2, null);
    expect(first.items.map((x) => x.id)).toEqual(['a', 'b']);
    const after = index.remove('d');
    expect(() => after.overlapPage(0, 10, 2, first.nextCursor)).toThrowError(CursorError);
    expect(drain(after, 0, 10, 2).items.map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
      'e',
    ]);
  });
});

describe('duplicate endpoints', () => {
  function dupIndex() {
    return new IntervalIndex<number>([
      { id: 'd', start: 5, end: 9, value: 4 },
      { id: 'b', start: 5, end: 9, value: 2 },
      { id: 'a', start: 5, end: 9, value: 1 },
      { id: 'c', start: 5, end: 9, value: 3 },
      { id: 'e', start: 5, end: 9, value: 5 },
      { id: 'pre', start: 1, end: 6, value: 0 },
      { id: 'post', start: 8, end: 12, value: 6 },
    ]);
  }

  it('orders equal (start, end) by id and pages without repeats at every boundary', () => {
    const index = dupIndex();
    const full = index.overlap(0, 20);
    expect(full.map((x) => x.id)).toEqual(['pre', 'a', 'b', 'c', 'd', 'e', 'post']);
    for (const pageSize of [1, 2, 3, 7]) {
      expect(drain(index, 0, 20, pageSize).items).toEqual(full);
      expect(drain(index, 0, 20, pageSize, 'desc').items).toEqual([...full].reverse());
    }
  });

  it('cursor on an exact duplicate key resumes strictly after it', () => {
    const index = dupIndex();
    // pageSize 4: the boundary lands in the middle of the five identical
    // (5,9) endpoints.
    const p1 = index.overlapPage(0, 20, 4, null);
    expect(p1.items.map((x) => x.id)).toEqual(['pre', 'a', 'b', 'c']);
    const p2 = index.overlapPage(0, 20, 4, p1.nextCursor);
    expect(p2.items.map((x) => x.id)).toEqual(['d', 'e', 'post']);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('empty pages', () => {
  it('no overlap: empty first page with null cursor', () => {
    const index = new IntervalIndex<number>(intervals(20));
    const page = index.overlapPage(100, 200, 5, null);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('final page smaller than pageSize ends with null cursor', () => {
    const index = new IntervalIndex<number>(intervals(20));
    const full = index.overlap(2, 8);
    const p1 = index.overlapPage(2, 8, full.length + 10, null);
    expect(p1.items).toEqual(full);
    expect(p1.nextCursor).toBeNull();
  });

  it('empty index', () => {
    const page = new IntervalIndex<number>().overlapPage(0, 10, 5, null);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects bad pageSize and non-finite range', () => {
    const index = new IntervalIndex<number>(intervals(5));
    expect(() => index.overlapPage(0, 10, 0, null)).toThrow(TypeError);
    expect(() => index.overlapPage(0, 10, 1.5, null)).toThrow(TypeError);
    expect(() => index.overlapPage(NaN, 10, 5, null)).toThrow(TypeError);
  });
});

describe('cursor tampering', () => {
  const index = new IntervalIndex<number>(intervals(30));

  it('garbage string', () => {
    expect(() => index.overlapPage(0, 20, 5, 'not-a-cursor')).toThrowError(CursorError);
    try {
      index.overlapPage(0, 20, 5, 'not-a-cursor');
    } catch (e) {
      expect((e as CursorError).code).toBe('INVALID_CURSOR');
    }
  });

  it('flipped character breaks checksum', () => {
    const cursor = index.overlapPage(0, 20, 5, null).nextCursor!;
    const bad = cursor.endsWith('A') ? cursor.slice(0, -1) + 'B' : cursor.slice(0, -1) + 'A';
    expect(() => index.overlapPage(0, 20, 5, bad)).toThrowError(CursorError);
  });

  it('payload mutation is rejected', () => {
    const cursor = index.overlapPage(0, 20, 5, null).nextCursor!;
    const bad = tamper(cursor, (j) => {
      j.q = [1, 20];
    });
    expect(() => index.overlapPage(0, 20, 5, bad)).toThrowError(CursorError);
    try {
      index.overlapPage(0, 20, 5, bad);
    } catch (e) {
      expect((e as CursorError).code).toBe('INVALID_CURSOR');
    }
  });

  it('unknown version is rejected distinctly', () => {
    const cursor = index.overlapPage(0, 20, 5, null).nextCursor!;
    const bad = tamper(cursor, (j) => {
      j.v = 2;
    });
    try {
      index.overlapPage(0, 20, 5, bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CursorError);
      expect((e as CursorError).code).toBe('UNSUPPORTED_CURSOR_VERSION');
    }
  });

  it('valid checksum but different range/direction is QUERY_MISMATCH', () => {
    const cursor = index.overlapPage(0, 20, 5, null).nextCursor!;
    try {
      index.overlapPage(1, 20, 5, cursor);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CursorError).code).toBe('QUERY_MISMATCH');
    }
    try {
      index.overlapPage(0, 20, 5, cursor, 'desc');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CursorError).code).toBe('QUERY_MISMATCH');
    }
  });
});

describe('snapshots and revisions', () => {
  it('old snapshots stay retained and their cursors keep working', () => {
    const v0 = new IntervalIndex<number>(intervals(10));
    const v1 = v0.add({ id: pad(50), start: 3, end: 7, value: 50 });
    const v2 = v1
      .add({ id: pad(60), start: 0, end: 2, value: 60 })
      .remove(pad(0));
    expect(v2.revision).not.toBe(v0.revision);
    expect(v1.revision).not.toBe(v0.revision);

    for (const [snap, lo, hi] of [
      [v0, 0, 20],
      [v1, 0, 20],
      [v2, 0, 20],
    ] as const) {
      expect(IntervalIndex.isSnapshotRetained(snap.revision)).toBe(true);
      expect(drain(snap, lo, hi, 3).items).toEqual(snap.overlap(lo, hi));
    }

    // A cursor minted against v0 mid-pagination is still fully resumable on v0
    // after v1/v2 (with rotations) were derived.
    const first = v0.overlapPage(0, 20, 3, null);
    const rest: Interval<number>[] = [];
    let cur = first.nextCursor;
    while (cur) {
      const page = v0.overlapPage(0, 20, 3, cur);
      rest.push(...page.items);
      cur = page.nextCursor;
    }
    expect([...first.items, ...rest]).toEqual(v0.overlap(0, 20));

    // And it cannot cross snapshots in either direction.
    expect(() => v2.overlapPage(0, 20, 3, first.nextCursor)).toThrowError(CursorError);
    const later = v2.overlapPage(0, 20, 3, null).nextCursor;
    expect(() => v0.overlapPage(0, 20, 3, later)).toThrowError(CursorError);
  });

  it('changing a value produces a new revision; stable keys still page identically', () => {
    const v0 = new IntervalIndex<number>(intervals(15));
    const updated = v0.add({ id: pad(3), start: 3 % 10, end: (3 % 10) + 5, value: 999 });
    expect(updated.revision).not.toBe(v0.revision);
    expect(updated.overlap(2, 8).find((x) => x.id === pad(3))!.value).toBe(999);
    expect(drain(updated, 2, 8, 4).items).toEqual(updated.overlap(2, 8));
  });

  it('empty snapshot has a stable revision distinct from non-empty', () => {
    const empty = new IntervalIndex<number>();
    const nonEmpty = empty.add({ id: 'a', start: 0, end: 1, value: 1 });
    expect(empty.revision).not.toBe(nonEmpty.revision);
    expect(new IntervalIndex<number>([]).revision).toBe(empty.revision);
  });
});
