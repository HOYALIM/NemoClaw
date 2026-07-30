// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateHermesCronRestoreBackup } from "../../state/rebuild/hermes-cron-restore-backup";

const processMocks = vi.hoisted(() => ({
  executeSandboxExecCommand: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxExecCommand: processMocks.executeSandboxExecCommand,
}));

import {
  beginHermesCronRestore,
  releaseHermesCronRestore,
  runHermesCronRestoreTransaction,
  validateHermesCronRestore,
} from "./rebuild-hermes-post-restore";

const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";

function writeJson(target: string, payload: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload));
}

function writeScript(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "print('ok')\n", { mode: 0o600 });
}

function receipt(action: string, pid = 41, startTime = 902): string {
  return `${RECEIPT_PREFIX}${JSON.stringify({
    version: 1,
    action,
    pid,
    start_time: startTime,
  })}`;
}

describe("Hermes cron rebuild restore contract", () => {
  let backupPath: string;

  beforeEach(() => {
    processMocks.executeSandboxExecCommand.mockReset();
    backupPath = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-"));
  });

  afterEach(() => {
    rmSync(backupPath, { recursive: true, force: true });
  });

  it("validates active default and named-profile scripts before deletion", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), {
      jobs: [
        { enabled: true, script: "collect.py" },
        { enabled: false, script: "disabled-missing.py" },
        { state: "paused", script: "paused-missing.py" },
      ],
    });
    writeScript(path.join(backupPath, "scripts", "collect.py"));
    writeJson(path.join(backupPath, "profiles", "research", "cron", "jobs.json"), [
      {
        script: "/sandbox/.hermes/profiles/research/scripts/report.sh",
      },
    ]);
    writeScript(path.join(backupPath, "profiles", "research", "scripts", "report.sh"));

    expect(validateHermesCronRestoreBackup(backupPath)).toEqual({
      activeJobs: 2,
      scriptJobs: 2,
      requiresDispatchGate: true,
    });
  });

  it("blocks a backup whose active job script is absent", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "missing.py" }]);
    mkdirSync(path.join(backupPath, "scripts"));

    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "active job #1 script is missing or unreadable",
    );
  });

  it("blocks unreadable and escaping script inputs", () => {
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "private.py" }]);
    const scriptPath = path.join(backupPath, "scripts", "private.py");
    writeScript(scriptPath);
    chmodSync(scriptPath, 0o000);

    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "active job #1 script is not readable",
    );

    chmodSync(scriptPath, 0o600);
    writeJson(path.join(backupPath, "cron", "jobs.json"), [{ script: "/tmp/outside.py" }]);
    expect(() => validateHermesCronRestoreBackup(backupPath)).toThrow(
      "script path resolves outside",
    );
  });

  it("binds validation and release to the begin receipt identity", () => {
    processMocks.executeSandboxExecCommand.mockImplementation(
      (_sandboxName: string, command: string) => {
        const action = command.includes(" validate ")
          ? "validate"
          : command.includes(" release ")
            ? "release"
            : "begin";
        return { status: 0, stdout: receipt(action), stderr: "" };
      },
    );

    const identity = beginHermesCronRestore("alpha");
    validateHermesCronRestore("alpha", identity);
    releaseHermesCronRestore("alpha", identity);

    expect(identity).toEqual({ pid: 41, start_time: 902 });
    expect(processMocks.executeSandboxExecCommand).toHaveBeenCalledTimes(3);
    expect(processMocks.executeSandboxExecCommand.mock.calls[1]?.[1]).toContain(
      "validate --pid 41 --start-time 902",
    );
    expect(processMocks.executeSandboxExecCommand.mock.calls[2]?.[1]).toContain(
      "release --pid 41 --start-time 902",
    );
  });

  it("rejects a control receipt that changes gateway identity", () => {
    processMocks.executeSandboxExecCommand.mockReturnValue({
      status: 0,
      stdout: receipt("release", 42, 902),
      stderr: "",
    });

    expect(() => releaseHermesCronRestore("alpha", { pid: 41, start_time: 902 })).toThrow(
      "changed gateway identity",
    );
  });

  it("keeps dispatch drained when state restore is incomplete", () => {
    processMocks.executeSandboxExecCommand.mockReturnValue({
      status: 0,
      stdout: receipt("begin"),
      stderr: "",
    });

    expect(() =>
      runHermesCronRestoreTransaction("alpha", () => ({ restoreSucceeded: false })),
    ).toThrow("state restore was incomplete");
    expect(processMocks.executeSandboxExecCommand).toHaveBeenCalledOnce();
    expect(processMocks.executeSandboxExecCommand.mock.calls[0]?.[1]).toContain(" begin");
  });

  it("orders drain, restore, validation, and release", () => {
    const events: string[] = [];
    processMocks.executeSandboxExecCommand.mockImplementation(
      (_sandboxName: string, command: string) => {
        const action = command.includes(" validate ")
          ? "validate"
          : command.includes(" release ")
            ? "release"
            : "begin";
        events.push(action);
        return { status: 0, stdout: receipt(action), stderr: "" };
      },
    );

    runHermesCronRestoreTransaction(
      "alpha",
      () => {
        events.push("restore");
        return { restoreSucceeded: true };
      },
      (state) => events.push(state),
    );

    expect(events).toEqual(["begin", "acquired", "restore", "validate", "release", "released"]);
  });
});
