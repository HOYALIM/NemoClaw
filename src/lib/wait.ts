// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous waiting primitives for CLI commands.
 */

export type WaitUntilOptions = {
  /** Absolute deadline, in milliseconds, using the same clock as `now`. */
  deadlineMs: number;
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

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFiniteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Poll a synchronous condition until it succeeds or the absolute deadline passes.
 */
export function waitUntil(condition: () => boolean, options: WaitUntilOptions): boolean {
  const deadlineMs = Number(options.deadlineMs);
  if (!Number.isFinite(deadlineMs)) {
    throw new TypeError("waitUntil requires a finite deadlineMs");
  }

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

  let attempts = 0;
  for (;;) {
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

    const currentMs = now();
    if (!Number.isFinite(currentMs) || currentMs >= deadlineMs) {
      return false;
    }

    sleeper(Math.min(intervalMs, deadlineMs - currentMs));
    intervalMs = Math.min(maxIntervalMs, intervalMs * backoffFactor);
  }
}
