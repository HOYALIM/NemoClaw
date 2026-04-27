// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert";
import { describe, expect, it } from "vitest";
import { sleepMs, sleepSeconds, waitUntil } from "../src/lib/wait.js";

describe("wait utility", () => {
  it("sleepMs blocks for approximately the requested time", () => {
    const start = performance.now();
    sleepMs(100);
    const end = performance.now();
    const duration = end - start;

    // Allow for some jitter, but should be at least 100ms.
    // Increased upper bound to 500ms to avoid CI flakes on loaded runners.
    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 500, `duration ${duration}ms > 500ms`);
  });

  it("sleepSeconds blocks for approximately the requested time", () => {
    const start = performance.now();
    sleepSeconds(0.1);
    const end = performance.now();
    const duration = end - start;

    assert.ok(duration >= 100, `duration ${duration}ms < 100ms`);
    assert.ok(duration < 500, `duration ${duration}ms > 500ms`);
  });

  it("returns immediately for zero, negative, or non-finite time", () => {
    const start = performance.now();
    sleepMs(0);
    sleepMs(-50);
    sleepMs(NaN);
    sleepMs(Infinity);
    const end = performance.now();
    const duration = end - start;
    assert.ok(duration < 50, `duration ${duration}ms > 50ms`);
  });

  it("waitUntil returns immediately when the condition is already true", () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return true;
      },
      {
        deadlineMs: 100,
        now: () => 0,
        sleep: (ms) => sleeps.push(ms),
      },
    );

    expect(result).toBe(true);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("waitUntil throws when deadlineMs is non-finite and no attempt cap is provided", () => {
    expect(() =>
      waitUntil(() => false, {
        deadlineMs: Number.NaN,
        now: () => 0,
        sleep: () => {},
      }),
    ).toThrow(TypeError);
  });

  it("waitUntil retries until the condition succeeds", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return attempts >= 3;
      },
      {
        deadlineMs: 100,
        initialIntervalMs: 10,
        maxIntervalMs: 10,
        backoffFactor: 1,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it("waitUntil returns false after the deadline passes", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 25,
        initialIntervalMs: 10,
        maxIntervalMs: 10,
        backoffFactor: 1,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10, 10, 5]);
  });

  it("waitUntil applies interval backoff up to the configured max interval", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return attempts >= 5;
      },
      {
        deadlineMs: 100,
        initialIntervalMs: 5,
        maxIntervalMs: 20,
        backoffFactor: 2,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(true);
    expect(sleeps).toEqual([5, 10, 20, 20]);
  });

  it("waitUntil can cap attempts while allowing zero-length intervals", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 1,
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        maxAttempts: 3,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it("waitUntil can rely on maxAttempts without a deadline", () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        maxAttempts: 3,
        now: () => 0,
        sleep: (ms) => sleeps.push(ms),
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it("waitUntil yields between unbounded zero-interval attempts", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let nowMs = 0;

    const result = waitUntil(
      () => {
        attempts += 1;
        return false;
      },
      {
        deadlineMs: 3,
        initialIntervalMs: 0,
        maxIntervalMs: 0,
        now: () => nowMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    expect(result).toBe(false);
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([1, 1, 1]);
  });
});
