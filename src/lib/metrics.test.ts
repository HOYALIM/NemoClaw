// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatMetricSummary,
  getMetricsFile,
  readMetricEvents,
  recordMetricEvent,
  resetMetricEvents,
  summarizeMetricEvents,
} from "../../dist/lib/metrics";

const originalHome = process.env.HOME;
const restoreOriginalHome =
  originalHome === undefined
    ? () => {
        delete process.env.HOME;
      }
    : () => {
        process.env.HOME = originalHome;
      };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-metrics-"));
  process.env.HOME = tmpDir;
});

afterEach(() => {
  restoreOriginalHome();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("metrics", () => {
  it("records local JSONL metric events", () => {
    const ok = recordMetricEvent("sandbox_connect", {
      sandbox: "alpha",
      command: "connect",
      status: "success",
    });

    expect(ok).toBe(true);
    const read = readMetricEvents();
    expect(read.invalidLines).toBe(0);
    expect(read.events).toHaveLength(1);
    expect(read.events[0]).toMatchObject({
      event: "sandbox_connect",
      sandbox: "alpha",
      command: "connect",
      status: "success",
    });
  });

  it("tightens existing metrics file permissions after recording", () => {
    const filePath = getMetricsFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", { mode: 0o666 });
    fs.chmodSync(filePath, 0o666);

    recordMetricEvent("sandbox_connect", {
      sandbox: "alpha",
      command: "connect",
    });

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("summarizes events globally and by sandbox", () => {
    recordMetricEvent("onboard_start", { command: "onboard" });
    recordMetricEvent("sandbox_connect", {
      sandbox: "alpha",
      command: "connect",
      status: "success",
    });
    recordMetricEvent("sandbox_destroy", {
      sandbox: "beta",
      command: "destroy",
      status: "success",
    });

    const read = readMetricEvents();
    const global = summarizeMetricEvents(read);
    const alpha = summarizeMetricEvents(read, "alpha");

    expect(global.totalEvents).toBe(3);
    expect(global.eventCounts).toMatchObject({
      onboard_start: 1,
      sandbox_connect: 1,
      sandbox_destroy: 1,
    });
    expect(global.sandboxCounts).toMatchObject({ alpha: 1, beta: 1 });
    expect(alpha.totalEvents).toBe(1);
    expect(alpha.eventCounts).toMatchObject({ sandbox_connect: 1 });
    expect(alpha.sandboxCounts).toMatchObject({ alpha: 1 });
  });

  it("skips malformed JSONL lines without failing the summary", () => {
    const filePath = getMetricsFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ time: "2026-04-26T00:00:00.000Z", event: "policy_apply" }),
        "{not-json",
        JSON.stringify({ event: "missing-time" }),
        JSON.stringify({ time: "2026-04-26T00:00:01.000Z", event: "unknown_event" }),
        JSON.stringify({
          time: "2026-04-26T00:00:02.000Z",
          event: "sandbox_connect",
          status: "unknown",
        }),
        "",
      ].join("\n"),
    );

    const read = readMetricEvents(filePath);
    const summary = summarizeMetricEvents(read);

    expect(read.events).toHaveLength(1);
    expect(read.invalidLines).toBe(4);
    expect(summary.invalidLines).toBe(4);
    expect(formatMetricSummary(summary, filePath)).toContain("Ignored malformed lines: 4");
  });

  it("resets the metrics file", () => {
    recordMetricEvent("policy_apply", {
      sandbox: "alpha",
      command: "policy-add",
      status: "success",
      data: { preset: "github" },
    });

    resetMetricEvents();

    expect(fs.readFileSync(getMetricsFile(), "utf8")).toBe("");
    expect(readMetricEvents().events).toHaveLength(0);
  });

  it("tightens existing metrics file permissions after reset", () => {
    const filePath = getMetricsFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "old\n", { mode: 0o666 });
    fs.chmodSync(filePath, 0o666);

    resetMetricEvents(filePath);

    expect(fs.readFileSync(filePath, "utf8")).toBe("");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
