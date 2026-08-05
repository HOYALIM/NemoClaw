// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-drain-control-cas.py");

const UPSTREAM_FIXTURE = `from __future__ import annotations

import functools
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from hermes_constants import get_hermes_home
from utils import atomic_json_write

_log = logging.getLogger(__name__)
_DRAIN_REQUEST_FILENAME = ".drain_request.json"

@functools.lru_cache(maxsize=1)
def current_instantiation_epoch() -> str:
    return "fixture-epoch"

def drain_request_path(home: Optional[Path] = None) -> Path:
    base = home if home is not None else get_hermes_home()
    return Path(base) / _DRAIN_REQUEST_FILENAME

def write_drain_request(
    *,
    principal: str = "drain-control",
    suppress_notification: bool = False,
    home: Optional[Path] = None,
) -> dict[str, Any]:
    payload = {
        "action": "drain",
        "requested_at": datetime.now(timezone.utc).isoformat(),
        "principal": principal,
        "epoch": current_instantiation_epoch(),
        "suppress_notification": bool(suppress_notification),
    }
    atomic_json_write(drain_request_path(home), payload)
    return payload

def clear_drain_request(*, home: Optional[Path] = None) -> bool:
    path = drain_request_path(home)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        _log.warning("drain-control: failed to remove %s: %s", path, e)
        return False

def _marker_epoch_is_stale(body: dict[str, Any]) -> bool:
    marker_epoch = body.get("epoch")
    return bool(marker_epoch and marker_epoch != current_instantiation_epoch())

def read_drain_request(*, home: Optional[Path] = None) -> Optional[dict[str, Any]]:
    try:
        payload = json.loads(drain_request_path(home).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    return payload if isinstance(payload, dict) else {}
`;

const ATOMIC_WRITE_FIXTURE = `import json
import os

def atomic_json_write(path, payload):
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(temp, path)
`;

const CONSTANTS_FIXTURE = `import os
from pathlib import Path

def get_hermes_home():
    return Path(os.environ["HERMES_HOME"])
`;

const CONCURRENCY_PROBE = `import json
import multiprocessing
import sys
from pathlib import Path

import drain_control

HOME = Path(sys.argv[1])

def create_once(principal, barrier, queue):
    barrier.wait()
    queue.put(drain_control.write_drain_request_if_absent(principal=principal, home=HOME) is not None)

def clear_owned(barrier):
    barrier.wait()
    drain_control.clear_drain_request_if_principal("restore", home=HOME)

def write_operator(barrier):
    barrier.wait()
    drain_control.write_drain_request(principal="operator", home=HOME)

def restore_if_absent(barrier):
    barrier.wait()
    drain_control.write_drain_request_if_absent(principal="restore", home=HOME)

def run_pair(left, right):
    barrier = multiprocessing.get_context("fork").Barrier(2)
    processes = [
        multiprocessing.get_context("fork").Process(target=left, args=(barrier,)),
        multiprocessing.get_context("fork").Process(target=right, args=(barrier,)),
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(5)
        assert process.exitcode == 0

if __name__ == "__main__":
    context = multiprocessing.get_context("fork")
    barrier = context.Barrier(8)
    queue = context.Queue()
    creators = [
        context.Process(target=create_once, args=(f"creator-{index}", barrier, queue))
        for index in range(8)
    ]
    for process in creators:
        process.start()
    for process in creators:
        process.join(5)
        assert process.exitcode == 0
    assert sum(queue.get(timeout=1) for _ in creators) == 1

    drain_control.write_drain_request(principal="restore", home=HOME)
    run_pair(clear_owned, write_operator)
    assert drain_control.read_drain_request(home=HOME)["principal"] == "operator"

    assert drain_control.clear_drain_request(home=HOME)
    run_pair(restore_if_absent, write_operator)
    assert drain_control.read_drain_request(home=HOME)["principal"] == "operator"
    print(json.dumps({"acquire_winners": 1, "release": "operator", "rollback": "operator"}))
`;

function fixture(): { drainControl: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-drain-cas-"));
  const drainControl = path.join(tmp, "drain_control.py");
  fs.writeFileSync(drainControl, UPSTREAM_FIXTURE);
  fs.writeFileSync(path.join(tmp, "hermes_constants.py"), CONSTANTS_FIXTURE);
  fs.writeFileSync(path.join(tmp, "utils.py"), ATOMIC_WRITE_FIXTURE);
  fs.writeFileSync(path.join(tmp, "probe.py"), CONCURRENCY_PROBE);
  return { drainControl, tmp };
}

describe("Hermes drain marker compare-and-set patch", () => {
  it("serializes acquisition, token-matched release, and rollback races", () => {
    const { drainControl, tmp } = fixture();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const patch = spawnSync("python3", ["-I", PATCHER, drainControl], {
          encoding: "utf-8",
          timeout: 5000,
        });
        expect(patch.status, patch.stderr).toBe(0);
      }

      const home = path.join(tmp, "home");
      fs.mkdirSync(home);
      const probe = spawnSync("python3", [path.join(tmp, "probe.py"), home], {
        cwd: tmp,
        encoding: "utf-8",
        timeout: 15_000,
      });

      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({
        acquire_winners: 1,
        release: "operator",
        rollback: "operator",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned clear helper changes", () => {
    const { drainControl, tmp } = fixture();
    try {
      const drifted = UPSTREAM_FIXTURE.replace("path.unlink()", "path.unlink(missing_ok=True)");
      fs.writeFileSync(drainControl, drifted);
      const patch = spawnSync("python3", ["-I", PATCHER, drainControl], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("drain-control source shape changed");
      expect(fs.readFileSync(drainControl, "utf-8")).toBe(drifted);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
