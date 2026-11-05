import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';
import type { DigestRow, NightDigest } from '../src/digest/types.js';

const NIGHT = '2026-01-02';

function rowFor(digest: NightDigest | null, job: string): DigestRow {
  const row = digest?.rows.find((candidate) => candidate.job === job);
  if (row === undefined) throw new Error(`no row for ${job}`);
  return row;
}

describe('readNight on the real night 2026-10-28', () => {
  const digest = readNight('runs', '2026-10-28');

  it('gives one row per job, sorted by job', () => {
    expect(digest?.night).toBe('2026-10-28');
    expect(digest?.rows.map((row) => row.job)).toEqual([
      'digest/render',
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
  });

  it('counts the truncated line as bad and every parsed line by status', () => {
    expect(digest?.badLines).toBe(1);
    expect(digest?.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
  });

  it('keeps the row of a job whose owner is null', () => {
    expect(rowFor(digest, 'digest/render').owner).toBeNull();
  });

  it('keeps the last error of a job that retried and then went ok', () => {
    expect(rowFor(digest, 'fixtures/refresh')).toEqual({
      job: 'fixtures/refresh',
      owner: 'rook',
      runs: 4,
      retries: 3,
      lastStatus: 'ok',
      lastError: 'upstream 503',
      firstAt: '2026-10-29T01:30:00+01:00',
      lastAt: '2026-10-29T01:37:00+01:00',
    });
  });

  it('shows a failed job as failed', () => {
    expect(rowFor(digest, 'notes/backup').lastStatus).toBe('fail');
  });
});

describe('readNight on invented nights', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-read-'));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  function digestOf(lines: string[]): NightDigest | null {
    writeFileSync(join(runsDir, `${NIGHT}.jsonl`), lines.join('\n'));
    return readNight(runsDir, NIGHT);
  }

  function runLine(fields: Record<string, unknown> = {}): string {
    return JSON.stringify({ at: '2026-01-02T23:00:00+01:00', job: 'a/job', status: 'ok', owner: 'rook', ...fields });
  }

  it('returns null for a night with no file', () => {
    expect(readNight(runsDir, NIGHT)).toBeNull();
  });

  it('returns empty rows for an empty file', () => {
    expect(digestOf([])).toEqual({
      night: NIGHT,
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it.each(['../etc', '2026-1-2', '2026-01-02\n', '2026-01-02.jsonl', '../2026-01-02', ''])(
    'returns null for the unsafe night %j',
    (night) => {
      writeFileSync(join(runsDir, `${NIGHT}.jsonl`), runLine());
      expect(readNight(runsDir, night)).toBeNull();
    },
  );

  it('does not read a file outside the runs folder', () => {
    const nested = join(runsDir, 'runs');
    mkdirSync(nested);
    writeFileSync(join(runsDir, 'secret.jsonl'), runLine());
    expect(readNight(nested, '../secret')).toBeNull();
  });

  it('lets read errors other than a missing file propagate', () => {
    mkdirSync(join(runsDir, `${NIGHT}.jsonl`));
    expect(() => readNight(runsDir, NIGHT)).toThrow();
  });

  it('ignores blank lines without counting them', () => {
    const digest = digestOf(['', runLine(), '   ', '\t', '']);
    expect(digest?.badLines).toBe(0);
    expect(digest?.rows).toHaveLength(1);
  });

  it('reads a file with Windows line endings', () => {
    const digest = digestOf([`${runLine()}\r`, '\r', runLine()]);
    expect(digest?.badLines).toBe(0);
    expect(digest?.rows[0]?.runs).toBe(2);
  });

  it.each([
    ['not JSON', '{"at":'],
    ['a JSON array', '[]'],
    ['a JSON string', '"ok"'],
    ['a JSON number', '1'],
    ['JSON null', 'null'],
    ['a missing job', JSON.stringify({ at: '2026-01-02T23:00:00+01:00', status: 'ok' })],
    ['a non-string job', runLine({ job: 7 })],
    ['an empty job', runLine({ job: '' })],
    ['a missing at', JSON.stringify({ job: 'a/job', status: 'ok' })],
    ['a non-string at', runLine({ at: 1767391200000 })],
    ['an unparseable at', runLine({ at: 'last night' })],
    ['an unknown status', runLine({ status: 'skipped' })],
    ['a missing status', JSON.stringify({ at: '2026-01-02T23:00:00+01:00', job: 'a/job' })],
    ['a non-string owner', runLine({ owner: 7 })],
    ['a non-string error', runLine({ error: { code: 503 } })],
    ['a null error', runLine({ error: null })],
  ])('counts %s as a bad line and adds no row', (_label, line) => {
    expect(digestOf([line])).toEqual({
      night: NIGHT,
      rows: [],
      badLines: 1,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('does not let a bad line change the row of its job', () => {
    const digest = digestOf([runLine({ status: 'fail', error: 'boom' }), runLine({ status: 'skipped', error: 'other' })]);
    expect(digest?.badLines).toBe(1);
    expect(digest?.rows[0]).toMatchObject({ runs: 1, lastStatus: 'fail', lastError: 'boom' });
  });

  it('counts every status as a run and only retry as a retry', () => {
    const digest = digestOf([runLine({ status: 'retry' }), runLine({ status: 'fail' }), runLine({ status: 'ok' })]);
    expect(digest?.rows[0]).toMatchObject({ runs: 3, retries: 1 });
    expect(digest?.counts).toEqual({ ok: 1, retry: 1, fail: 1 });
  });

  it('takes the most recent error, and null when there never was one', () => {
    const digest = digestOf([
      runLine({ job: 'a/flaky', status: 'retry', error: 'first' }),
      runLine({ job: 'a/flaky', status: 'retry', error: 'second' }),
      runLine({ job: 'a/flaky' }),
      runLine({ job: 'b/calm' }),
    ]);
    expect(rowFor(digest, 'a/flaky').lastError).toBe('second');
    expect(rowFor(digest, 'b/calm').lastError).toBeNull();
  });

  it('takes the owner from the last parsed line, even when that owner is null', () => {
    const digest = digestOf([
      runLine({ job: 'a/orphaned' }),
      runLine({ job: 'a/orphaned', owner: null }),
      runLine({ job: 'b/adopted', owner: null }),
      runLine({ job: 'b/adopted', owner: 'lane-07' }),
    ]);
    expect(rowFor(digest, 'a/orphaned').owner).toBeNull();
    expect(rowFor(digest, 'b/adopted').owner).toBe('lane-07');
  });

  it('counts a line with no owner key as owner null', () => {
    const digest = digestOf([JSON.stringify({ at: '2026-01-02T23:00:00+01:00', job: 'a/job', status: 'ok' })]);
    expect(digest?.badLines).toBe(0);
    expect(digest?.rows[0]?.owner).toBeNull();
  });

  it('keeps times exactly as written, in file order, with their offset', () => {
    const digest = digestOf([
      runLine({ at: '2026-01-03T01:00:00+09:00' }),
      runLine({ at: '2026-01-02T23:00:00-05:00' }),
    ]);
    expect(digest?.rows[0]).toMatchObject({
      firstAt: '2026-01-03T01:00:00+09:00',
      lastAt: '2026-01-02T23:00:00-05:00',
    });
  });

  it('sorts by plain string comparison, not locale', () => {
    const digest = digestOf(['b', 'a', 'B', 'é', 'Z'].map((job) => runLine({ job })));
    expect(digest?.rows.map((row) => row.job)).toEqual(['B', 'Z', 'a', 'b', 'é']);
  });

  it('handles a job named like a built-in object property', () => {
    const digest = digestOf([runLine({ job: '__proto__' }), runLine({ job: 'constructor' })]);
    expect(digest?.rows.map((row) => row.job)).toEqual(['__proto__', 'constructor']);
  });
});
