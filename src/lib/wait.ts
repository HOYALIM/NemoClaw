// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous waiting primitives for CLI commands.
 */

export type WaitUntilOptions = {
  /** Absolute deadline, in milliseconds, using the same clock as `now`. */
  deadlineMs?: number;
  /** First delay between failed attempts. */
  initialIntervalMs?: number;
  /** Maximum delay between failed attempts after backoff. */
  maxIntervalMs?: number;
  /** Multiplier applied to the interval after each failed attempt. */
  backoffFactor?: number;
  /** Optional cap on condition attempts, including the first immediate check. */
  maxAttempts?: number;
  /** Clock used for deadline comparisons. Defaults to Date.now. */
  now?: () => number;
  /** Blocking sleep function. Defaults to sleepMs. */
  sleep?: (ms: number) => void;
};

const DEFAULT_INITIAL_INTERVAL_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_FACTOR = 1.5;
const MIN_UNCAPPED_SLEEP_MS = 1;

/**
 * Synchronously sleep for the given number of milliseconds.
 * Uses Atomics.wait to block without pegging the CPU.
 */
export function sleepMs(ms: number): void {
  if (ms <= 0 || !Number.isFinite(ms)) return;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/**
 * Synchronously sleep for the given number of seconds.
 */
export function sleepSeconds(seconds: number): void {
  sleepMs(seconds * 1000);
}

/**
 * Return a positive finite number, or a fallback when the option is absent or invalid.
 */
function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Return a non-negative finite number, or a fallback when the option is absent or invalid.
 */
function nonNegativeFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Poll a synchronous condition until it succeeds, the deadline passes, or attempts run out.
 *
 * Callers must provide either a finite deadline or a finite maxAttempts cap.
 */
export function waitUntil(condition: () => boolean, options: WaitUntilOptions): boolean {
  const now = options.now ?? Date.now;
  const sleeper = options.sleep ?? sleepMs;
  const maxIntervalMs = nonNegativeFiniteOr(options.maxIntervalMs, DEFAULT_MAX_INTERVAL_MS);
  let intervalMs = Math.min(
    nonNegativeFiniteOr(options.initialIntervalMs, DEFAULT_INITIAL_INTERVAL_MS),
    maxIntervalMs,
  );
  const backoffFactor = Math.max(
    1,
    positiveFiniteOr(options.backoffFactor, DEFAULT_BACKOFF_FACTOR),
  );
  const maxAttempts =
    options.maxAttempts !== undefined && Number.isFinite(options.maxAttempts)
      ? Math.max(0, Math.floor(options.maxAttempts))
      : Number.POSITIVE_INFINITY;
  const hasAttemptCap = Number.isFinite(maxAttempts);

  const deadlineMs =
    options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : Number(options.deadlineMs);
  if (Number.isNaN(deadlineMs) || deadlineMs === Number.NEGATIVE_INFINITY) {
    throw new TypeError("waitUntil requires a valid deadlineMs");
  }
  if (deadlineMs === Number.POSITIVE_INFINITY && !hasAttemptCap) {
    throw new TypeError("waitUntil requires deadlineMs or maxAttempts");
  }

  let attempts = 0;
  for (;;) {
    const currentMs = now();
    if (!Number.isFinite(currentMs) || currentMs >= deadlineMs) {
      return false;
    }

    if (attempts >= maxAttempts) {
      return false;
    }
    attempts += 1;

    if (condition()) {
      return true;
    }
    if (attempts >= maxAttempts) {
      return false;
    }

    const remainingMs = deadlineMs - currentMs;
    const requestedSleepMs = Math.min(intervalMs, remainingMs);
    const sleepDurationMs =
      !hasAttemptCap && requestedSleepMs <= 0 ? MIN_UNCAPPED_SLEEP_MS : requestedSleepMs;
    sleeper(Math.min(sleepDurationMs, remainingMs));
    intervalMs = Math.min(maxIntervalMs, intervalMs * backoffFactor);
  }
}
