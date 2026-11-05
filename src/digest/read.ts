import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, NightDigest, ReadNight } from './types.js';

type Status = DigestRow['lastStatus'];

type RunLine = {
  at: string;
  job: string;
  status: Status;
  owner: string | null;
  error?: string;
};

const NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is Status {
  return value === 'ok' || value === 'retry' || value === 'fail';
}

// Returns null for a bad line.
function parseRunLine(text: string): RunLine | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;

  const { at, job, status, owner = null, error } = value;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (typeof job !== 'string' || job === '') return null;
  if (!isStatus(status)) return null;
  if (owner !== null && typeof owner !== 'string') return null;
  if (error === undefined) return { at, job, status, owner };
  if (typeof error !== 'string') return null;
  return { at, job, status, owner, error };
}

function updatedRow(previous: DigestRow | undefined, line: RunLine): DigestRow {
  return {
    job: line.job,
    owner: line.owner,
    runs: (previous?.runs ?? 0) + 1,
    retries: (previous?.retries ?? 0) + (line.status === 'retry' ? 1 : 0),
    lastStatus: line.status,
    lastError: line.error ?? previous?.lastError ?? null,
    firstAt: previous?.firstAt ?? line.at,
    lastAt: line.at,
  };
}

function compareByJob(a: DigestRow, b: DigestRow): number {
  if (a.job === b.job) return 0;
  return a.job < b.job ? -1 : 1;
}

function digestNight(night: string, content: string): NightDigest {
  const rowsByJob = new Map<string, DigestRow>();
  const counts = { ok: 0, retry: 0, fail: 0 };
  let badLines = 0;

  for (const text of content.split('\n')) {
    if (text.trim() === '') continue;
    const line = parseRunLine(text);
    if (line === null) {
      badLines += 1;
      continue;
    }
    counts[line.status] += 1;
    rowsByJob.set(line.job, updatedRow(rowsByJob.get(line.job), line));
  }

  return { night, rows: [...rowsByJob.values()].sort(compareByJob), badLines, counts };
}

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!NIGHT_PATTERN.test(night)) return null;
  const content = readFileIfExists(join(runsDir, `${night}.jsonl`));
  return content === null ? null : digestNight(night, content);
};
