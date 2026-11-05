// Plan morning-digest § 1. Types only: every part of § 2 codes against this file.

export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: 'ok' | 'retry' | 'fail';
  lastError: string | null;
  // Exactly as written in the log, offset kept.
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string;
  // One row per job, sorted by job.
  rows: DigestRow[];
  // Lines that did not parse. Counted, never thrown.
  badLines: number;
  // Parsed lines per status, for the status board.
  counts: { ok: number; retry: number; fail: number };
};

/**
 * Implemented and exported as `readNight` from `src/digest/read.ts`.
 *
 * Returns `null` when the night has no file, or when `night` is not a date.
 * An empty file returns empty `rows` with `badLines: 0`.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
