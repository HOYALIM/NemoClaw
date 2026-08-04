// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = path.resolve("agents/hermes/cron-restore-control.py");
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const LIFECYCLE_HARNESS = String.raw`
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("cron_restore_control", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = sys.argv[2]
module.HERMES_HOME = Path(sys.argv[3])
module.validate_cron_tree = lambda: {
    "profiles": 1,
    "active_jobs": 1,
    "script_jobs": 1,
}

class DrainControl:
    @staticmethod
    def drain_request_path(home):
        return Path(home) / ".drain_request.json"

    @property
    def marker(self):
        return self.read_drain_request(home=module.HERMES_HOME)

    @marker.setter
    def marker(self, value):
        path = self.drain_request_path(module.HERMES_HOME)
        if value is None:
            path.unlink(missing_ok=True)
            return
        path.write_text(__import__("json").dumps(value), encoding="utf-8")

    def write_drain_request(self, **kwargs):
        payload = {"principal": kwargs["principal"]}
        path = self.drain_request_path(kwargs["home"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(__import__("json").dumps(payload), encoding="utf-8")
        return payload

    def drain_requested(self, **kwargs):
        marker = self.read_drain_request(**kwargs)
        return marker is not None and marker.get("principal") != "stale"

    def read_drain_request(self, **kwargs):
        path = self.drain_request_path(kwargs["home"])
        try:
            return __import__("json").loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def clear_drain_request(self, **kwargs):
        path = self.drain_request_path(kwargs["home"])
        if not path.exists():
            return False
        path.unlink()
        return True

class Status:
    payload = {
        "pid": 41,
        "start_time": 902,
        "gateway_state": "draining",
        "active_agents": 0,
    }

    def read_runtime_status(self):
        return self.payload

    def get_runtime_status_running_pid(self, *, runtime, expected_home):
        return runtime["pid"]

    def parse_active_agents(self, value):
        return int(value)

drain = DrainControl()
status = Status()
module._load_gateway_modules = lambda: (drain, status)

try:
    if scenario == "success":
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        status.payload["gateway_state"] = "running"
        module.release_drain(41, 902, token)
    elif scenario == "wrong-identity":
        drain.marker = {"principal": "operator"}
        module.validate_restore(42, 902, None)
    elif scenario == "missing-marker":
        module.release_drain(41, 902, None)
    elif scenario == "preserve-operator":
        drain.marker = {"principal": "operator"}
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.release_drain(41, 902, token)
        print("FINAL_MARKER:" + drain.marker["principal"])
    elif scenario == "concurrent-operator":
        original_link = module.os.link
        def operator_wins(source, destination):
            drain.marker = {"principal": "operator"}
            return original_link(source, destination)
        module.os.link = operator_wins
        token = module.begin_drain()
        module.validate_restore(41, 902, token)
        module.release_drain(41, 902, token)
        print("FINAL_MARKER:" + drain.marker["principal"])
    elif scenario == "stale-marker":
        drain.marker = {"principal": "stale"}
        try:
            module.begin_drain()
        finally:
            print("FINAL_MARKER:" + drain.marker["principal"])
    elif scenario == "link-failure":
        def fail_link(*_args):
            raise OSError("unsupported")
        module.os.link = fail_link
        module.begin_drain()
    elif scenario == "replacement-operator":
        token = module.begin_drain()
        drain.marker = {"principal": "operator"}
        try:
            module.release_drain(41, 902, token)
        finally:
            print("FINAL_MARKER:" + drain.marker["principal"])
    elif scenario == "rollback-operator":
        token = module.begin_drain()
        def fail_after_operator_replaces_marker(*_args, **_kwargs):
            drain.marker = {"principal": "operator"}
            raise module.ControlError("simulated reactivation failure")
        module._wait_for_state = fail_after_operator_replaces_marker
        try:
            module.release_drain(41, 902, token)
        finally:
            print("FINAL_MARKER:" + drain.marker["principal"])
    else:
        raise RuntimeError(f"unknown scenario: {scenario}")
except module.ControlError as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
`;

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

  function runLifecycle(
    scenario:
      | "success"
      | "wrong-identity"
      | "missing-marker"
      | "preserve-operator"
      | "concurrent-operator"
      | "stale-marker"
      | "link-failure"
      | "replacement-operator"
      | "rollback-operator",
  ) {
    return spawnSync(
      process.env.PYTHON || "python3",
      ["-I", "-c", LIFECYCLE_HARNESS, HELPER, scenario, hermesHome],
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

  it("pins one gateway identity across begin, validation, and release", () => {
    const result = runLifecycle("success");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const receipts = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts.map((receipt) => receipt.action)).toEqual(["begin", "validate", "release"]);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 41, start_time: 902 }),
        expect.objectContaining({ active_jobs: 1, profiles: 1, script_jobs: 1 }),
      ]),
    );
  });

  it("rejects validation against a different gateway identity", () => {
    const result = runLifecycle("wrong-identity");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway identity changed during cron restore");
  });

  it("rejects release after the drain marker disappears", () => {
    const result = runLifecycle("missing-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain marker disappeared before release");
  });

  it("preserves an operator-owned drain across begin, validation, and release", () => {
    const result = runLifecycle("preserve-operator");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.drain_acquired === false)).toBe(true);
    expect(receipts.every((receipt) => receipt.drain_token === undefined)).toBe(true);
  });

  it("preserves an operator drain created during acquisition", () => {
    const result = runLifecycle("concurrent-operator");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FINAL_MARKER:operator");
    const receipts = result.stdout
      .split("\n")
      .filter((line) => line.startsWith(RECEIPT_PREFIX))
      .map((line) => JSON.parse(line.slice(RECEIPT_PREFIX.length)));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.drain_acquired === false)).toBe(true);
  });

  it("fails closed without replacing a stale drain marker", () => {
    const result = runLifecycle("stale-marker");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale Hermes drain marker prevents");
    expect(result.stdout).toContain("FINAL_MARKER:stale");
  });

  it("fails closed when atomic drain acquisition is unavailable", () => {
    const result = runLifecycle("link-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain could not be acquired");
  });

  it("does not clear an operator marker that replaces its owned drain", () => {
    const result = runLifecycle("replacement-operator");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("drain ownership changed");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
  });

  it("does not overwrite an operator marker during failed release rollback", () => {
    const result = runLifecycle("rollback-operator");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated reactivation failure");
    expect(result.stdout).toContain("FINAL_MARKER:operator");
  });
});
