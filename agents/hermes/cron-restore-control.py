# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Gate Hermes cron dispatch while NemoClaw restores durable state."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Any

HERMES_HOME = Path("/sandbox/.hermes")
SANDBOX_HOME = Path("/sandbox")
RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:"
DRAIN_PRINCIPAL_PREFIX = "nemoclaw-cron-restore:"
BEGIN_TIMEOUT_SECONDS = 60.0
RELEASE_TIMEOUT_SECONDS = 15.0
POLL_SECONDS = 0.1
MAX_JOBS_BYTES = 8 * 1024 * 1024


class ControlError(RuntimeError):
    """Expected fail-closed control or validation error."""


def _profile_homes(home: Path) -> list[tuple[str, Path]]:
    profiles: list[tuple[str, Path]] = [("default", home)]
    profiles_root = home / "profiles"
    try:
        entries = sorted(profiles_root.iterdir(), key=lambda entry: entry.name)
    except FileNotFoundError:
        return profiles
    except OSError as error:
        raise ControlError("named profile state is unreadable") from error

    for index, entry in enumerate(entries, start=1):
        try:
            mode = entry.lstat().st_mode
        except OSError as error:
            raise ControlError(f"named profile #{index} is unreadable") from error
        if stat.S_ISLNK(mode):
            raise ControlError(f"named profile #{index} is a symlink")
        if stat.S_ISDIR(mode):
            profiles.append((f"named profile #{index}", entry))
    return profiles


def _load_jobs(profile_label: str, profile_home: Path) -> list[dict[str, Any]]:
    jobs_path = profile_home / "cron" / "jobs.json"
    try:
        metadata = jobs_path.lstat()
    except FileNotFoundError:
        return []
    except OSError as error:
        raise ControlError(f"{profile_label} cron store is unreadable") from error

    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ControlError(f"{profile_label} cron store is not a regular file")
    if metadata.st_size > MAX_JOBS_BYTES:
        raise ControlError(f"{profile_label} cron store exceeds the validation limit")
    try:
        payload = json.loads(jobs_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ControlError(f"{profile_label} cron store is invalid") from error

    jobs = (
        payload
        if isinstance(payload, list)
        else payload.get("jobs")
        if isinstance(payload, dict)
        else None
    )
    if not isinstance(jobs, list):
        raise ControlError(f"{profile_label} cron store has an invalid jobs collection")
    if not all(isinstance(job, dict) for job in jobs):
        raise ControlError(f"{profile_label} cron store contains an invalid job")
    return jobs


def _expand_script_path(raw: str, scripts_root: Path, sandbox_home: Path) -> Path:
    if "\0" in raw:
        raise ControlError("script path contains a NUL byte")
    candidate = Path(raw)
    if raw == "~":
        candidate = sandbox_home
    elif raw.startswith("~/"):
        candidate = sandbox_home / raw[2:]
    elif raw.startswith("~"):
        raise ControlError("script path uses an unsupported user-home expansion")
    elif not candidate.is_absolute():
        candidate = scripts_root / candidate
    return candidate


def _validate_script(
    profile_label: str,
    job_index: int,
    script: str,
    profile_home: Path,
    sandbox_home: Path,
) -> None:
    scripts_root = profile_home / "scripts"
    candidate = _expand_script_path(script, scripts_root, sandbox_home)
    try:
        root_metadata = scripts_root.lstat()
        target_metadata = candidate.lstat()
        resolved_root = scripts_root.resolve(strict=True)
        resolved_target = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise ControlError(
            f"{profile_label} active job #{job_index} references a missing script"
        ) from error

    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ControlError(f"{profile_label} scripts root is not a regular directory")
    if stat.S_ISLNK(target_metadata.st_mode) or not stat.S_ISREG(target_metadata.st_mode):
        raise ControlError(
            f"{profile_label} active job #{job_index} script is not a regular file"
        )
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError as error:
        raise ControlError(
            f"{profile_label} active job #{job_index} script escapes its profile"
        ) from error
    if not target_metadata.st_mode & 0o444 or not os.access(resolved_target, os.R_OK):
        raise ControlError(
            f"{profile_label} active job #{job_index} script is not readable"
        )


def validate_cron_tree(
    home: Path = HERMES_HOME,
    sandbox_home: Path = SANDBOX_HOME,
) -> dict[str, int]:
    profile_count = 0
    active_jobs = 0
    script_jobs = 0
    for profile_label, profile_home in _profile_homes(home):
        profile_count += 1
        for job_index, job in enumerate(_load_jobs(profile_label, profile_home), start=1):
            if job.get("enabled", True) is False or job.get("state") == "paused":
                continue
            active_jobs += 1
            script = job.get("script")
            if script is None or script == "":
                continue
            if not isinstance(script, str) or not script.strip():
                raise ControlError(
                    f"{profile_label} active job #{job_index} has an invalid script"
                )
            script_jobs += 1
            _validate_script(
                profile_label,
                job_index,
                script.strip(),
                profile_home,
                sandbox_home,
            )
    return {
        "profiles": profile_count,
        "active_jobs": active_jobs,
        "script_jobs": script_jobs,
    }


def _load_gateway_modules() -> tuple[Any, Any]:
    os.environ["HERMES_HOME"] = str(HERMES_HOME)
    try:
        from gateway import drain_control, status
    except Exception as error:
        raise ControlError("pinned Hermes gateway control modules are unavailable") from error
    return drain_control, status


def _gateway_identity(status_module: Any) -> tuple[dict[str, Any], int, int]:
    payload = status_module.read_runtime_status()
    if not isinstance(payload, dict):
        raise ControlError("Hermes gateway runtime status is unavailable")
    pid = payload.get("pid")
    start_time = payload.get("start_time")
    if not isinstance(pid, int) or pid <= 0:
        raise ControlError("Hermes gateway PID identity is invalid")
    if not isinstance(start_time, int) or start_time < 0:
        raise ControlError("Hermes gateway start identity is invalid")
    running_pid = status_module.get_runtime_status_running_pid(
        runtime=payload,
        expected_home=HERMES_HOME,
    )
    if running_pid != pid:
        raise ControlError("Hermes gateway process identity is not live")
    return payload, pid, start_time


def _require_identity(status_module: Any, pid: int, start_time: int) -> dict[str, Any]:
    payload, observed_pid, observed_start = _gateway_identity(status_module)
    if observed_pid != pid or observed_start != start_time:
        raise ControlError("Hermes gateway identity changed during cron restore")
    return payload


def _wait_for_state(
    status_module: Any,
    *,
    pid: int,
    start_time: int,
    state: str,
    require_idle: bool,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_payload: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        last_payload = _require_identity(status_module, pid, start_time)
        active_agents = status_module.parse_active_agents(last_payload.get("active_agents"))
        if last_payload.get("gateway_state") == state and (not require_idle or active_agents == 0):
            return last_payload
        time.sleep(POLL_SECONDS)
    observed_state = last_payload.get("gateway_state") if last_payload else "unavailable"
    raise ControlError(f"Hermes gateway did not reach {state} from {observed_state}")


def _receipt(
    action: str,
    pid: int,
    start_time: int,
    drain_token: str | None,
    **fields: Any,
) -> None:
    payload = {
        "version": 1,
        "action": action,
        "pid": pid,
        "start_time": start_time,
        "drain_acquired": drain_token is not None,
        **fields,
    }
    if drain_token is not None:
        payload["drain_token"] = drain_token
    print(f"{RECEIPT_PREFIX}{json.dumps(payload, separators=(',', ':'), sort_keys=True)}")


def _require_owned_drain(drain_control: Any, drain_token: str) -> None:
    marker = drain_control.read_drain_request(home=HERMES_HOME)
    if not isinstance(marker, dict) or marker.get("principal") != (
        f"{DRAIN_PRINCIPAL_PREFIX}{drain_token}"
    ):
        raise ControlError("Hermes cron restore drain ownership changed")


def begin_drain() -> str | None:
    drain_control, status_module = _load_gateway_modules()
    _, pid, start_time = _gateway_identity(status_module)
    drain_token: str | None = None
    if not drain_control.drain_requested(home=HERMES_HOME):
        drain_token = secrets.token_urlsafe(24)
        marker = drain_control.write_drain_request(
            principal=f"{DRAIN_PRINCIPAL_PREFIX}{drain_token}",
            suppress_notification=True,
            home=HERMES_HOME,
        )
        if marker.get("principal") != f"{DRAIN_PRINCIPAL_PREFIX}{drain_token}":
            raise ControlError("Hermes cron restore drain ownership was not recorded")
    payload = _wait_for_state(
        status_module,
        pid=pid,
        start_time=start_time,
        state="draining",
        require_idle=True,
        timeout_seconds=BEGIN_TIMEOUT_SECONDS,
    )
    _receipt(
        "begin",
        pid,
        start_time,
        drain_token,
        active_agents=status_module.parse_active_agents(payload.get("active_agents")),
    )
    return drain_token


def validate_restore(pid: int, start_time: int, drain_token: str | None) -> None:
    drain_control, status_module = _load_gateway_modules()
    if not drain_control.drain_requested(home=HERMES_HOME):
        raise ControlError("Hermes cron restore drain marker is not active")
    if drain_token is not None:
        _require_owned_drain(drain_control, drain_token)
    payload = _require_identity(status_module, pid, start_time)
    if payload.get("gateway_state") != "draining":
        raise ControlError("Hermes gateway is not draining during cron validation")
    if status_module.parse_active_agents(payload.get("active_agents")) != 0:
        raise ControlError("Hermes gateway became active during cron validation")
    counts = validate_cron_tree()
    _receipt("validate", pid, start_time, drain_token, **counts)


def release_drain(pid: int, start_time: int, drain_token: str | None) -> None:
    drain_control, status_module = _load_gateway_modules()
    _require_identity(status_module, pid, start_time)
    if not drain_control.drain_requested(home=HERMES_HOME):
        raise ControlError("Hermes cron restore drain marker disappeared before release")
    if drain_token is None:
        _receipt("release", pid, start_time, None, preserved_drain=True)
        return
    _require_owned_drain(drain_control, drain_token)
    if not drain_control.clear_drain_request(home=HERMES_HOME):
        raise ControlError("Hermes cron restore drain marker could not be cleared")
    try:
        payload = _wait_for_state(
            status_module,
            pid=pid,
            start_time=start_time,
            state="running",
            require_idle=False,
            timeout_seconds=RELEASE_TIMEOUT_SECONDS,
        )
    except Exception:
        # Re-engage the same pinned marker contract before failing so dispatch
        # cannot resume without a verified running receipt.
        if not drain_control.drain_requested(home=HERMES_HOME):
            drain_control.write_drain_request(
                principal=f"{DRAIN_PRINCIPAL_PREFIX}{drain_token}",
                suppress_notification=True,
                home=HERMES_HOME,
            )
        raise
    _receipt(
        "release",
        pid,
        start_time,
        drain_token,
        active_agents=status_module.parse_active_agents(payload.get("active_agents")),
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("begin")
    for action in ("validate", "release"):
        subparser = subparsers.add_parser(action)
        subparser.add_argument("--pid", required=True, type=int)
        subparser.add_argument("--start-time", required=True, type=int)
        subparser.add_argument("--drain-token")
    tree = subparsers.add_parser("validate-tree")
    tree.add_argument("--home", required=True, type=Path)
    tree.add_argument("--sandbox-home", required=True, type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.action == "begin":
            begin_drain()
        elif args.action == "validate":
            validate_restore(args.pid, args.start_time, args.drain_token)
        elif args.action == "release":
            release_drain(args.pid, args.start_time, args.drain_token)
        else:
            counts = validate_cron_tree(args.home, args.sandbox_home)
            print(json.dumps(counts, separators=(",", ":"), sort_keys=True))
    except ControlError as error:
        print(f"HERMES_CRON_RESTORE_ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
