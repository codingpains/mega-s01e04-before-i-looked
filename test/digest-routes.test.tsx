import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { RigConfig } from '../src/config.js';

// Nights are fixtures in a temp folder. The real runs/ folder is never read here.
const NIGHT_MISSING = '2026-11-01';
const NIGHT_EMPTY = '2026-10-30';
const NIGHT_CLEAN = '2026-10-31';
const NIGHT_BAD_LINE = '2026-10-29';

const JOBS_IN_JOB_ORDER = ['digest/render', 'fixtures/refresh', 'lane/sync', 'notes/backup'];

function runLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ at: '2026-10-29T01:00:00+01:00', owner: 'rook', status: 'ok', ...fields });
}

// Deliberately not in job order, with a bad line and a null owner.
const BAD_LINE_NIGHT = [
  runLine({ at: '2026-10-29T01:10:00+01:00', job: 'notes/backup', status: 'fail', owner: 'rook', error: 'disk full' }),
  runLine({ at: '2026-10-29T01:05:00+01:00', job: 'lane/sync', status: 'retry', owner: 'ines', error: 'timeout' }),
  'not json at all',
  runLine({ at: '2026-10-29T01:20:00+01:00', job: 'digest/render', status: 'ok', owner: null }),
  runLine({ at: '2026-10-29T01:21:00+01:00', job: 'fixtures/refresh', status: 'retry', error: 'upstream 503' }),
  runLine({ at: '2026-10-29T01:22:00+01:00', job: 'fixtures/refresh', status: 'retry', error: 'upstream 503' }),
  runLine({ at: '2026-10-29T01:23:00+01:00', job: 'fixtures/refresh', status: 'retry', error: 'upstream 503' }),
  runLine({ at: '2026-10-29T01:24:00+01:00', job: 'fixtures/refresh', status: 'ok' }),
  runLine({ at: '2026-10-29T01:06:00+01:00', job: 'lane/sync', status: 'retry', owner: 'ines', error: 'timeout' }),
  runLine({ at: '2026-10-29T01:07:00+01:00', job: 'lane/sync', status: 'ok', owner: 'ines' }),
];

const CLEAN_NIGHT = [
  runLine({ at: '2026-10-31T01:00:00+01:00', job: 'digest/render', status: 'ok', owner: null }),
  runLine({ at: '2026-10-31T01:01:00+01:00', job: 'lane/sync', status: 'ok', owner: 'ines' }),
];

let runsDir: string;
let config: RigConfig;

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  writeFileSync(join(runsDir, `${NIGHT_EMPTY}.jsonl`), '');
  writeFileSync(join(runsDir, `${NIGHT_CLEAN}.jsonl`), CLEAN_NIGHT.join('\n'));
  writeFileSync(join(runsDir, `${NIGHT_BAD_LINE}.jsonl`), BAD_LINE_NIGHT.join('\n'));
  config = {
    adapter: 'shim',
    installed: '2026-10-29T14:06:00+01:00',
    beatEverySeconds: 60,
    runsDir,
  };
});

afterAll(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function app() {
  return createApp(config);
}

// The HTML of the one table row that holds this job.
function rowOf(html: string, job: string): string {
  const row = html.split('<tr').find((chunk) => chunk.includes(job));
  if (row === undefined) throw new Error(`no row for ${job}`);
  return row.split('</tr>')[0] ?? '';
}

function jobOrderIn(html: string): string[] {
  const table = html.slice(html.indexOf('<table'));
  return JOBS_IN_JOB_ORDER.map((job) => ({ job, at: table.indexOf(job) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.job);
}

describe('GET /digest/:night', () => {
  it('returns 200 with a table for a night with lines', async () => {
    const res = await app().request(`/digest/${NIGHT_BAD_LINE}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<table');
  });

  it('returns 404 naming the night when there is no file', async () => {
    const res = await app().request(`/digest/${NIGHT_MISSING}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(`no digest for ${NIGHT_MISSING}`);
  });

  it('returns 404 for a night that is not a date', async () => {
    const res = await app().request('/digest/not-a-date');
    expect(res.status).toBe(404);
  });

  it('says nothing ran for an empty night, with no table', async () => {
    const res = await app().request(`/digest/${NIGHT_EMPTY}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('nothing ran');
    expect(html).not.toContain('<table');
  });

  it('renders a null owner as an em dash', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    expect(rowOf(html, 'digest/render')).toContain('—');
  });

  it('marks a job with 3 or more retries, and a job whose last status is fail, with a warn cell', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    for (const job of ['fixtures/refresh', 'notes/backup']) {
      const row = rowOf(html, job);
      expect(row).toContain('class="warn"');
      expect(row).toContain('!');
    }
  });

  it('does not mark a job with 2 retries that ended ok', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    expect(rowOf(html, 'lane/sync')).not.toContain('class="warn"');
  });

  it('shows the bad line count when there is a bad line', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    expect(html).toContain('bad lines: 1');
  });

  it('says nothing about bad lines when there are none', async () => {
    const html = await (await app().request(`/digest/${NIGHT_CLEAN}`)).text();
    expect(html).toContain('<table');
    expect(html).not.toContain('bad lines');
  });

  it('lists the jobs in job order even when the log is not', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    expect(jobOrderIn(html)).toEqual(JOBS_IN_JOB_ORDER);
  });
});

describe('GET /api/digest/:night', () => {
  it('returns 200 with rows, bad line count and counts for a night with a bad line', async () => {
    const res = await app().request(`/api/digest/${NIGHT_BAD_LINE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      night: NIGHT_BAD_LINE,
      badLines: 1,
      counts: { ok: 3, retry: 5, fail: 1 },
      rows: [
        {
          job: 'digest/render',
          owner: null,
          runs: 1,
          retries: 0,
          lastStatus: 'ok',
          lastError: null,
          firstAt: '2026-10-29T01:20:00+01:00',
          lastAt: '2026-10-29T01:20:00+01:00',
        },
        {
          job: 'fixtures/refresh',
          owner: 'rook',
          runs: 4,
          retries: 3,
          lastStatus: 'ok',
          lastError: 'upstream 503',
          firstAt: '2026-10-29T01:21:00+01:00',
          lastAt: '2026-10-29T01:24:00+01:00',
        },
        {
          job: 'lane/sync',
          owner: 'ines',
          runs: 3,
          retries: 2,
          lastStatus: 'ok',
          lastError: 'timeout',
          firstAt: '2026-10-29T01:05:00+01:00',
          lastAt: '2026-10-29T01:07:00+01:00',
        },
        {
          job: 'notes/backup',
          owner: 'rook',
          runs: 1,
          retries: 0,
          lastStatus: 'fail',
          lastError: 'disk full',
          firstAt: '2026-10-29T01:10:00+01:00',
          lastAt: '2026-10-29T01:10:00+01:00',
        },
      ],
    });
  });

  it('returns 404 when there is no file', async () => {
    const res = await app().request(`/api/digest/${NIGHT_MISSING}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a night that is not a date', async () => {
    const res = await app().request('/api/digest/not-a-date');
    expect(res.status).toBe(404);
  });

  it('returns 200 with no rows and no bad lines for the empty night', async () => {
    const res = await app().request(`/api/digest/${NIGHT_EMPTY}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ night: NIGHT_EMPTY, rows: [], badLines: 0 });
  });

  it('returns 0 bad lines for a clean night, with null owners kept as null', async () => {
    const body = await (await app().request(`/api/digest/${NIGHT_CLEAN}`)).json();
    expect(body.badLines).toBe(0);
    expect(body.rows.find((row: { job: string }) => row.job === 'digest/render').owner).toBeNull();
  });

  it('gives every row the same fields the digest defines', async () => {
    const body = await (await app().request(`/api/digest/${NIGHT_BAD_LINE}`)).json();
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['firstAt', 'job', 'lastAt', 'lastError', 'lastStatus', 'owner', 'retries', 'runs'].sort(),
      );
    }
  });
});

describe('order of jobs on the page and in the JSON', () => {
  it('matches the JSON rows order for a log that is not in job order', async () => {
    const html = await (await app().request(`/digest/${NIGHT_BAD_LINE}`)).text();
    const json = await (await app().request(`/api/digest/${NIGHT_BAD_LINE}`)).json();
    const jsonJobs = json.rows.map((row: { job: string }) => row.job);

    expect(jsonJobs).toEqual(JOBS_IN_JOB_ORDER);
    expect(jobOrderIn(html)).toEqual(jsonJobs);
  });
});
