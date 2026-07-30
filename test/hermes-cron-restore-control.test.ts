// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = path.resolve("agents/hermes/cron-restore-control.py");

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload));
}

describe("Hermes in-sandbox cron restore validator", () => {
  let root: string;
  let hermesHome: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-helper-"));
    hermesHome = path.join(root, ".hermes");
    mkdirSync(hermesHome);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function validateTree() {
    return spawnSync(
      process.env.PYTHON || "python3",
      ["-I", HELPER, "validate-tree", "--home", hermesHome, "--sandbox-home", root],
      { encoding: "utf8" },
    );
  }

  it("accepts complete active scripts and ignores disabled missing scripts", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [
      { script: "collect.py" },
      { enabled: false, script: "missing.py" },
    ]);
    mkdirSync(path.join(hermesHome, "scripts"));
    writeFileSync(path.join(hermesHome, "scripts", "collect.py"), "print('ok')\n", {
      mode: 0o600,
    });

    const result = validateTree();

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      active_jobs: 1,
      profiles: 1,
      script_jobs: 1,
    });
  });

  it("fails closed when an active script has no readable permission bits", () => {
    writeJson(path.join(hermesHome, "cron", "jobs.json"), [{ script: "private.py" }]);
    mkdirSync(path.join(hermesHome, "scripts"));
    const scriptPath = path.join(hermesHome, "scripts", "private.py");
    writeFileSync(scriptPath, "print('private')\n");
    chmodSync(scriptPath, 0o000);

    const result = validateTree();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active job #1 script is not readable");
  });
});
