import { describe, expect, it } from 'vitest';
import {
  Interval,
  IntervalIndex,
  InvalidCursorError,
  Page,
  QueryMismatchError,
  StaleCursorError,
} from '../src/index.js';

/* Deterministic pseudo-random data (LCG), so every run is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeIntervals(n: number, seed = 7): Array<Interval<number>> {
  const rand = lcg(seed);
  const out: Array<Interval<number>> = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rand() * 30);
    const len = 1 + Math.floor(rand() * 6);
    out.push({ id: 'i' + i, start, end: start + len, value: i });
  }
  return out;
}

/** Concatenate every page on a fixed snapshot; ends when cursor is null. */
function paginateAll<V>(
  index: IntervalIndex<V>,
  options: {
    start: number;
    end: number;
    limit: number;
    direction?: 'asc' | 'desc';
  },
): { pages: Array<Page<V>>; items: Array<Interval<V>> } {
  const pages: Array<Page<V>> = [];
  const items: Array<Interval<V>> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = index.queryPage({ ...options, cursor });
    pages.push(page);
    items.push(...page.items);
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  return { pages, items };
}

describe('IntervalIndex basics', () => {
  it('queries overlapping intervals (legacy API)', () => {
    expect(
      new IntervalIndex<number>()
        .add({ id: 'a', start: 1, end: 3, value: 1 })
        .overlap(2, 4),
    ).toHaveLength(1);
  });

  it('rejects inverted ranges', () => {
    expect(() =>
      new IntervalIndex<number>().add({
        id: 'a',
        start: 5,
        end: 1,
        value: 0,
      }),
    ).toThrow('range');
  });

  it('is persistent: add/remove return new snapshots', () => {
    const a = new IntervalIndex<number>();
    const b = a.add({ id: 'a', start: 0, end: 2, value: 1 });
    expect(a.size).toBe(0);
    expect(b.size).toBe(1);
    const c = b.remove('a');
    expect(b.size).toBe(1);
    expect(c.size).toBe(0);
  });

  it('rejects non-positive limits', () => {
    const idx = new IntervalIndex<number>(makeIntervals(10));
    expect(() => idx.queryPage({ start: 0, end: 5, limit: 0 })).toThrow(
      RangeError,
    );
    expect(() => idx.queryPage({ start: 0, end: 5, limit: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe('revision identity', () => {
  it('is bound to root content, not insertion order or tree shape', () => {
    const items = makeIntervals(60);
    const shuffled = [...items].reverse();
    const a = new IntervalIndex<number>(items);
    const b = new IntervalIndex<number>(shuffled);
    expect(a.revision).toBe(b.revision);
  });

  it('changes when content changes and returns after undo', () => {
    const base = new IntervalIndex<number>(makeIntervals(40));
    const added = base.add({ id: 'zzz', start: 100, end: 101, value: -1 });
    expect(added.revision).not.toBe(base.revision);
    const undone = added.remove('zzz');
    expect(undone.revision).toBe(base.revision);
  });
});

describe('AVL rotation', () => {
  it('rotates during sequential inserts yet pagination stays complete', () => {
    let idx = new IntervalIndex<number>();
    let unbalanced = false;
    for (let i = 0; i < 200; i++) {
      idx = idx.add({ id: 'i' + i, start: i, end: i + 2, value: i });
      // A naive BST of 200 sequential inserts would have height 200;
      // any meaningful rebalancing keeps it logarithmic.
      if (idx.treeHeight > 30) unbalanced = true;
    }
    expect(unbalanced).toBe(false);
    expect(idx.treeHeight).toBeLessThan(12);

    const { items, pages } = paginateAll(idx, {
      start: 0,
      end: 500,
      limit: 7,
    });
    expect(items).toHaveLength(200);
    // 28 full pages of 7 + a final page of 4; every row exactly once.
    expect(pages).toHaveLength(29);
    expect(pages[pages.length - 1].items).toHaveLength(4);
    expect(new Set(items.map((x) => x.id)).size).toBe(200);
  });

  it('rebuilds a rotated, equal-content tree and preserves revision identity', () => {
    // add then remove restores content; rotations along the mutated paths must
    // not leak a new identity, and old snapshots must remain usable.
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 100; i++) {
      idx = idx.add({ id: 'i' + i, start: i, end: i + 2, value: i });
    }
    const withExtra = idx.add({ id: 'rot', start: 500, end: 501, value: -1 });
    const undone = withExtra.remove('rot');
    expect(undone.revision).toBe(idx.revision);
    expect(withExtra.size).toBe(101);
    expect(idx.size).toBe(100);
    const { items } = paginateAll(undone, { start: 0, end: 1000, limit: 13 });
    expect(items).toHaveLength(100);
  });

  it('cursor is portable across trees of identical content but different shape', () => {
    const items = makeIntervals(80);
    const ascending = new IntervalIndex<number>(items);
    const descending = new IntervalIndex<number>([...items].reverse());
    expect(ascending.revision).toBe(descending.revision);
    // Reverse insertion order builds the mirrored AVL tree: different physical
    // layout (node paths/stack indexes would be invalid), same logical root.
    expect(ascending.treeShape).not.toBe(descending.treeShape);

    const first = ascending.queryPage({ start: 0, end: 40, limit: 5 });
    const cursor = first.cursor!;
    const a = paginateAll(ascending, { start: 0, end: 40, limit: 5 });
    const b = paginateAll(descending, { start: 0, end: 40, limit: 5 });
    expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
    // Resume mid-stream on the physically different (rotated/mirrored) tree:
    // re-location by stable key yields exactly the same continuation.
    const resumed = descending.queryPage({
      start: 0,
      end: 40,
      limit: 5,
      cursor,
    });
    expect(resumed.items).toEqual(a.pages[1].items);
    expect(first.items).toEqual(a.pages[0].items);
  });
});

describe('delete last item', () => {
  it('removing the final sorted item of a page resumes cleanly', () => {
    const idx = new IntervalIndex<number>(makeIntervals(60));
    const full = idx.overlap(0, 1000);
    const lastId = full[full.length - 1].id;

    const p1 = idx.queryPage({ start: 0, end: 1000, limit: 25 });
    const next = idx.remove(lastId);
    expect(next.revision).not.toBe(idx.revision);
    expect(() =>
      next.queryPage({ start: 0, end: 1000, limit: 25, cursor: p1.cursor! }),
    ).toThrow(StaleCursorError);

    // Restarting on the new snapshot yields exactly the surviving rows.
    const restarted = paginateAll(next, { start: 0, end: 1000, limit: 25 });
    expect(restarted.items).toHaveLength(full.length - 1);
    expect(restarted.items.find((x) => x.id === lastId)).toBeUndefined();
  });

  it('deleting the final item invalidates its cursor on the new revision', () => {
    // 10 items, page size 5: the last full page points at the final rows.
    // Delete the final match: restarting on the new snapshot ends one row
    // earlier without skipping or repeating anything.
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 10; i++) {
      idx = idx.add({ id: 'i' + i, start: 0, end: 10, value: i });
    }
    const p1 = idx.queryPage({ start: 0, end: 10, limit: 5 });
    const trimmed = idx.remove('i9');
    expect(() =>
      trimmed.queryPage({ start: 0, end: 10, limit: 5, cursor: p1.cursor! }),
    ).toThrow(StaleCursorError);

    const { items, pages } = paginateAll(trimmed, {
      start: 0,
      end: 10,
      limit: 5,
    });
    expect(items).toHaveLength(9);
    // Leftover of 4 after the first full page: it is the final, short page.
    expect(pages).toHaveLength(2);
    expect(pages[0].items).toHaveLength(5);
    expect(pages[1].items).toHaveLength(4);
    expect(pages[1].cursor).toBeNull();
    expect(items.find((x) => x.id === 'i9')).toBeUndefined();
  });
});

describe('duplicate endpoints', () => {
  it('orders ties by (start, end, id) without skipping or repeating', () => {
    let idx = new IntervalIndex<number>();
    for (const id of ['c', 'a', 'b', 'a2', 'b2']) {
      idx = idx.add({ id, start: 1, end: 5, value: 0 });
    }
    // Two more sharing start but differing in end.
    idx = idx.add({ id: 'x', start: 1, end: 3, value: 0 });
    idx = idx.add({ id: 'y', start: 1, end: 9, value: 0 });

    const expected = idx.overlap(0, 10).map((x) => x.id);
    const { items, pages } = paginateAll(idx, {
      start: 0,
      end: 10,
      limit: 2,
    });
    expect(items.map((x) => x.id)).toEqual(expected);
    // Boundary pages in both directions must not duplicate the tie endpoints.
    for (const p of pages.slice(0, -1)) expect(p.items).toHaveLength(2);

    const desc = paginateAll(idx, {
      start: 0,
      end: 10,
      limit: 3,
      direction: 'desc',
    });
    expect(desc.items.map((x) => x.id)).toEqual([...expected].reverse());
  });
});

describe('forward and reverse pagination', () => {
  it('matches one-shot overlap query in asc and desc for many windows', () => {
    const idx = new IntervalIndex<number>(makeIntervals(120, 13));
    for (const [start, end] of [
      [-5, 2],
      [0, 1],
      [5, 12],
      [10, 11],
      [25, 40],
      [100, 200],
    ]) {
      for (const limit of [1, 2, 7, 1000]) {
        const all = idx.overlap(start, end);
        const asc = paginateAll(idx, { start, end, limit });
        expect(asc.items).toEqual(all);
        const desc = paginateAll(idx, {
          start,
          end,
          limit,
          direction: 'desc',
        });
        expect(desc.items).toEqual([...all].reverse());
      }
    }
  });

  it('respects resume direction (a desc cursor cannot be used asc)', () => {
    const idx = new IntervalIndex<number>(makeIntervals(30));
    const descCursor = idx.queryPage({
      start: 0,
      end: 40,
      limit: 5,
      direction: 'desc',
    }).cursor!;
    expect(() =>
      idx.queryPage({
        start: 0,
        end: 40,
        limit: 5,
        direction: 'asc',
        cursor: descCursor,
      }),
    ).toThrow(QueryMismatchError);
  });
});

describe('empty pages and empty windows', () => {
  it('returns an empty first page and null cursor when nothing matches', () => {
    const idx = new IntervalIndex<number>(makeIntervals(30));
    const page = idx.queryPage({ start: 1000, end: 2000, limit: 5 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  it('works on an empty snapshot', () => {
    const idx = new IntervalIndex<number>();
    const page = idx.queryPage({ start: 0, end: 10, limit: 5 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  it('emits a trailing empty page when matches are an exact multiple of limit', () => {
    // 10 matches, limit 5 -> pages of 5, 5, then an empty confirming page.
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 10; i++) {
      idx = idx.add({ id: 'i' + i, start: i, end: i + 1, value: i });
    }
    const p1 = idx.queryPage({ start: 0, end: 100, limit: 5 });
    expect(p1.items).toHaveLength(5);
    const p2 = idx.queryPage({
      start: 0,
      end: 100,
      limit: 5,
      cursor: p1.cursor!,
    });
    expect(p2.items).toHaveLength(5);
    expect(p2.cursor).not.toBeNull();
    const p3 = idx.queryPage({
      start: 0,
      end: 100,
      limit: 5,
      cursor: p2.cursor!,
    });
    expect(p3.items).toEqual([]);
    expect(p3.cursor).toBeNull();
  });

  it('emits a short final page (no empty page) with one remainder row', () => {
    // 11 matches, limit 5 -> pages of 5, 5, 1 and stop.
    let idx = new IntervalIndex<number>();
    for (let i = 0; i < 11; i++) {
      idx = idx.add({ id: 'i' + i, start: i, end: i + 1, value: i });
    }
    const p1 = idx.queryPage({ start: 0, end: 100, limit: 5 });
    const p2 = idx.queryPage({
      start: 0,
      end: 100,
      limit: 5,
      cursor: p1.cursor!,
    });
    const p3 = idx.queryPage({
      start: 0,
      end: 100,
      limit: 5,
      cursor: p2.cursor!,
    });
    expect(p3.items).toHaveLength(1);
    expect(p3.cursor).toBeNull();
  });
});

describe('cursor tampering', () => {
  const tamper = (token: string): string => {
    // Flip one character of the payload (before the checksum separator).
    const dot = token.lastIndexOf('.');
    const pos = dot - 1;
    const ch = token[pos];
    const replacement = ch === 'A' ? 'B' : 'A';
    return token.slice(0, pos) + replacement + token.slice(pos + 1);
  };

  it('rejects garbage, truncation and flipped payload bytes', () => {
    const idx = new IntervalIndex<number>(makeIntervals(40));
    const cursor = idx.queryPage({
      start: 0,
      end: 40,
      limit: 5,
    }).cursor!;

    for (const bad of [
      '',
      'not-a-cursor',
      cursor.slice(0, cursor.length - 3),
      cursor.slice(4),
      cursor.replace('.', '_'),
      tamper(cursor),
      btoa('{"v":1}'),
      'AAAA.deadbeef',
    ]) {
      expect(() =>
        idx.queryPage({ start: 0, end: 40, limit: 5, cursor: bad }),
      ).toThrow(InvalidCursorError);
    }
  });

  it('rejects non-string cursors', () => {
    const idx = new IntervalIndex<number>(makeIntervals(10));
    expect(() =>
      idx.queryPage({
        start: 0,
        end: 40,
        limit: 5,
        cursor: 123 as unknown as string,
      }),
    ).toThrow(InvalidCursorError);
  });
});

describe('revision and query fingerprint', () => {
  it('fails explicitly (never guesses) when the revision differs', () => {
    const idx = new IntervalIndex<number>(makeIntervals(50));
    const cursor = idx.queryPage({
      start: 0,
      end: 40,
      limit: 5,
    }).cursor!;
    const changed = idx.add({ id: 'new', start: 2, end: 8, value: 99 });
    expect(changed.revision).not.toBe(idx.revision);
    expect(() =>
      changed.queryPage({ start: 0, end: 40, limit: 5, cursor }),
    ).toThrow(StaleCursorError);
  });

  it('fails when the query window or direction changes', () => {
    const idx = new IntervalIndex<number>(makeIntervals(50));
    const cursor = idx.queryPage({
      start: 0,
      end: 40,
      limit: 5,
    }).cursor!;
    expect(() =>
      idx.queryPage({ start: 1, end: 40, limit: 5, cursor }),
    ).toThrow(QueryMismatchError);
    expect(() =>
      idx.queryPage({ start: 0, end: 41, limit: 5, cursor }),
    ).toThrow(QueryMismatchError);
    expect(() =>
      idx.queryPage({
        start: 0,
        end: 40,
        limit: 99,
        cursor,
      }),
    ).not.toThrow(); // limit is not part of the fingerprint
  });
});

describe('old snapshots retained', () => {
  it('keeps cursors of prior revisions valid on their own snapshot', () => {
    const s0 = new IntervalIndex<number>(makeIntervals(30, 21));
    const s1 = s0.add({ id: 'added', start: 3, end: 9, value: 100 });
    const s2 = s1.remove('i5');
    expect(s0.revision).not.toBe(s1.revision);
    expect(s1.revision).not.toBe(s2.revision);

    const c0 = s0.queryPage({ start: 0, end: 40, limit: 4 }).cursor!;
    const c1 = s1.queryPage({ start: 0, end: 40, limit: 4 }).cursor!;

    // New snapshot rejects old cursors...
    expect(() =>
      s2.queryPage({ start: 0, end: 40, limit: 4, cursor: c0 }),
    ).toThrow(StaleCursorError);
    // ...but the retained old snapshots still accept their own cursors.
    const on0 = paginateAll(s0, { start: 0, end: 40, limit: 4 });
    expect(on0.items).toEqual(s0.overlap(0, 40));
    expect(() =>
      s0.queryPage({ start: 0, end: 40, limit: 4, cursor: c0 }),
    ).not.toThrow();
    const resumed1 = s1.queryPage({
      start: 0,
      end: 40,
      limit: 4,
      cursor: c1,
    });
    expect(resumed1.items[0].id).not.toBe(
      s1.queryPage({ start: 0, end: 40, limit: 4 }).items[0].id,
    );
    // Full continuation from c1 on s1 equals the one-shot query.
    const rest1: Array<Interval<number>> = [...resumed1.items];
    let cur = resumed1.cursor;
    while (cur !== null) {
      const p = s1.queryPage({ start: 0, end: 40, limit: 4, cursor: cur });
      rest1.push(...p.items);
      cur = p.cursor;
    }
    expect([
      ...s1.queryPage({ start: 0, end: 40, limit: 4 }).items,
      ...rest1,
    ]).toEqual(s1.overlap(0, 40));
  });
});

describe('fixed-snapshot pagination equals one complete query', () => {
  it('stitches pages identically for random data, windows and page sizes', () => {
    for (const seed of [1, 42, 99]) {
      const idx = new IntervalIndex<number>(makeIntervals(150, seed));
      for (const [start, end] of [
        [-10, 0],
        [0, 5],
        [3, 30],
        [12, 13],
        [0, 1000],
      ]) {
        for (const limit of [1, 3, 8, 50, 200]) {
          for (const direction of ['asc', 'desc'] as const) {
            const { items } = paginateAll(idx, {
              start,
              end,
              limit,
              direction,
            });
            const oneShot =
              direction === 'asc'
                ? idx.overlap(start, end)
                : [...idx.overlap(start, end)].reverse();
            expect(items).toEqual(oneShot);
            expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
          }
        }
      }
    }
  });
});
