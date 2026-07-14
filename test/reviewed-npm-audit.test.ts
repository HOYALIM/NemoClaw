// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exceedsAuditThreshold,
  parseAuditReport,
  resolvePathWithinTargetRoot,
  vulnerabilityCounts,
} from "../scripts/audit-reviewed-npm-graph.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reviewed npm audit gate", () => {
  it("fails at high or critical findings while retaining lower severities", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 3, low: 2, moderate: 1, high: 4, critical: 5 },
      },
    };
    const counts = vulnerabilityCounts(report);
    expect(exceedsAuditThreshold(counts, CONFIG.severityThreshold)).toBe(9);
    expect(exceedsAuditThreshold(counts, "critical")).toBe(5);
  });

  it("accepts npm's nonzero audit status when a complete finding report explains it", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
      },
    };
    expect(parseAuditReport({ status: 1, stderr: "", stdout: JSON.stringify(report) })).toEqual(
      report,
    );
  });

  it("rejects a parseable npm transport failure instead of treating it as clean", () => {
    expect(() =>
      parseAuditReport({
        status: 1,
        stderr: "npm registry unavailable",
        stdout: JSON.stringify({
          error: { code: "ECONNREFUSED", summary: "request to registry failed" },
        }),
      }),
    ).toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["missing metadata", {}],
    [
      "invalid severity count",
      { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: "0", critical: 0 } } },
    ],
  ])("rejects %s", (_label, report) => {
    expect(() =>
      parseAuditReport({ status: 0, stderr: "", stdout: JSON.stringify(report) }),
    ).toThrow(/vulnerability report|vulnerability count/);
  });

  it.each(["direct", "ancestor"])("rejects a %s symlink in an audit target", (layout) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-audit-path-"));
    roots.push(root);
    const outside = path.join(root, "outside");
    const targetRoot = path.join(root, "repo");
    fs.mkdirSync(outside);
    fs.mkdirSync(targetRoot);

    if (layout === "direct") {
      fs.writeFileSync(path.join(outside, "config.json"), "{}");
      fs.mkdirSync(path.join(targetRoot, "ci"));
      fs.symlinkSync(path.join(outside, "config.json"), path.join(targetRoot, "ci", "config.json"));
    } else {
      fs.symlinkSync(outside, path.join(targetRoot, "artifacts"));
    }

    const relative = layout === "direct" ? "ci/config.json" : "artifacts/audit";
    expect(() => resolvePathWithinTargetRoot(targetRoot, relative, "audit target")).toThrow(
      "contains a symbolic-link component",
    );
  });
});
