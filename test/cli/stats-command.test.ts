// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv } from "./helpers";

type MetricFixture = Record<string, unknown>;

function writeMetrics(home: string, events: readonly MetricFixture[]): string {
  const metricsDir = path.join(home, ".nemoclaw");
  const metricsFile = path.join(metricsDir, "metrics.jsonl");
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(metricsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return metricsFile;
}

function writeSandboxRegistry(home: string, sandboxName: string): void {
  const registryDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: sandboxName,
    }),
    { mode: 0o600 },
  );
}

describe("stats CLI", () => {
  it("stats prints aggregate local metrics", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stats-"));
    writeMetrics(home, [
      {
        time: "2026-04-26T00:00:00.000Z",
        event: "onboard_start",
        command: "onboard",
      },
      {
        time: "2026-04-26T00:01:00.000Z",
        event: "sandbox_connect",
        sandbox: "alpha",
        command: "connect",
        status: "success",
      },
    ]);

    const result = runWithEnv("stats", { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toContain("NemoClaw stats");
    expect(result.out).toContain("Events: 2");
    expect(result.out).toContain("onboard_start");
    expect(result.out).toContain("sandbox_connect");
    expect(result.out).toContain("alpha");
  });

  it("stats --reset clears local metrics", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stats-reset-"));
    const metricsFile = writeMetrics(home, [
      {
        time: "2026-04-26T00:00:00.000Z",
        event: "onboard_start",
        command: "onboard",
      },
    ]);

    const result = runWithEnv("stats --reset", { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Metrics reset:");
    expect(fs.readFileSync(metricsFile, "utf8")).toBe("");
  });

  it("sandbox stats filters metrics by sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-stats-"));
    writeSandboxRegistry(home, "alpha");
    writeMetrics(home, [
      {
        time: "2026-04-26T00:01:00.000Z",
        event: "sandbox_connect",
        sandbox: "alpha",
        command: "connect",
        status: "success",
      },
      {
        time: "2026-04-26T00:02:00.000Z",
        event: "sandbox_connect",
        sandbox: "beta",
        command: "connect",
        status: "success",
      },
    ]);

    const result = runWithEnv("alpha stats", { HOME: home });

    expect(result.code).toBe(0);
    expect(result.out).toContain("NemoClaw stats for sandbox 'alpha'");
    expect(result.out).toContain("Events: 1");
    expect(result.out).toContain("sandbox_connect");
    expect(result.out).not.toContain("beta");
  });
});
