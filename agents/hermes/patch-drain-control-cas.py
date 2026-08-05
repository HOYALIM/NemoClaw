#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Add serialized create-only and principal-matched Hermes drain operations.

Hermes v2026.7.20 exposes unconditional marker replace and unlink helpers.
NemoClaw's cron restore transaction needs a compare-and-set boundary so it
cannot overwrite or clear an operator drain that races with begin or release.
Patch the canonical module so dashboard, gateway, and restore-controller
writers all participate in the same filesystem lock.

Remove this patch when the minimum supported Hermes release provides these
primitives natively.
"""

from __future__ import annotations

import argparse
from pathlib import Path


OLD_IMPORTS = """import functools
import json
import logging
"""
NEW_IMPORTS = """import fcntl
import functools
import json
import logging
import os
from contextlib import contextmanager
"""

OLD_CONSTANTS = """_DRAIN_REQUEST_FILENAME = ".drain_request.json"
"""
NEW_CONSTANTS = """_DRAIN_REQUEST_FILENAME = ".drain_request.json"
_DRAIN_REQUEST_LOCK_FILENAME = ".drain_request.lock"
"""

WRITE_ANCHOR = """def write_drain_request(
"""
LOCK_AND_WRITE_HELPERS = '''def drain_request_lock_path(home: Optional[Path] = None) -> Path:
    """Absolute path to the shared drain-request transaction lock."""
    base = home if home is not None else get_hermes_home()
    return Path(base) / _DRAIN_REQUEST_LOCK_FILENAME


@contextmanager
def _drain_request_lock(home: Optional[Path] = None):
    """Serialize every drain marker writer across gateway processes."""
    flags = os.O_RDONLY | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(drain_request_lock_path(home), flags, 0o666)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _write_drain_request_unlocked(
    *,
    principal: str,
    suppress_notification: bool,
    home: Optional[Path],
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


def write_drain_request(
'''

OLD_WRITE_BODY = """    payload = {
        "action": "drain",
        "requested_at": datetime.now(timezone.utc).isoformat(),
        "principal": principal,
        "epoch": current_instantiation_epoch(),
        "suppress_notification": bool(suppress_notification),
    }
    atomic_json_write(drain_request_path(home), payload)
    return payload
"""
NEW_WRITE_BODY = """    with _drain_request_lock(home):
        return _write_drain_request_unlocked(
            principal=principal,
            suppress_notification=suppress_notification,
            home=home,
        )
"""

CLEAR_ANCHOR = """def clear_drain_request(*, home: Optional[Path] = None) -> bool:
"""
CLEAR_HELPER = """def _clear_drain_request_unlocked(*, home: Optional[Path] = None) -> bool:
    path = drain_request_path(home)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        _log.warning("drain-control: failed to remove %s: %s", path, e)
        return False


def clear_drain_request(*, home: Optional[Path] = None) -> bool:
"""

OLD_CLEAR_BODY = """    path = drain_request_path(home)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        _log.warning("drain-control: failed to remove %s: %s", path, e)
        return False
"""
NEW_CLEAR_BODY = """    with _drain_request_lock(home):
        return _clear_drain_request_unlocked(home=home)
"""

STALE_ANCHOR = """def _marker_epoch_is_stale(body: dict[str, Any]) -> bool:
"""
CAS_PRIMITIVES = '''def write_drain_request_if_absent(
    *,
    principal: str = "drain-control",
    suppress_notification: bool = False,
    home: Optional[Path] = None,
) -> Optional[dict[str, Any]]:
    """Create or replace only an absent or definitely stale drain marker."""
    with _drain_request_lock(home):
        body = read_drain_request(home=home)
        if body is not None and not _marker_epoch_is_stale(body):
            return None
        return _write_drain_request_unlocked(
            principal=principal,
            suppress_notification=suppress_notification,
            home=home,
        )


def clear_drain_request_if_principal(
    principal: str,
    *,
    home: Optional[Path] = None,
) -> bool:
    """Remove the marker only while its principal still matches."""
    with _drain_request_lock(home):
        body = read_drain_request(home=home)
        if not isinstance(body, dict) or body.get("principal") != principal:
            return False
        return _clear_drain_request_unlocked(home=home)


def _marker_epoch_is_stale(body: dict[str, Any]) -> bool:
'''


def replace_exact(source: str, old: str, new: str, label: str) -> str:
    old_count = source.count(old)
    new_count = source.count(new)
    if new_count == 1:
        return source
    if old_count != 1 or new_count != 0:
        raise SystemExit(
            "ERROR: Hermes drain-control source shape changed; "
            f"expected one unpatched {label}, found {old_count} "
            f"(already patched: {new_count})"
        )
    return source.replace(old, new)


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    replacements = (
        (OLD_IMPORTS, NEW_IMPORTS, "import block"),
        (OLD_CONSTANTS, NEW_CONSTANTS, "constant block"),
        (OLD_WRITE_BODY, NEW_WRITE_BODY, "write body"),
        (OLD_CLEAR_BODY, NEW_CLEAR_BODY, "clear body"),
        (WRITE_ANCHOR, LOCK_AND_WRITE_HELPERS, "write helper anchor"),
        (CLEAR_ANCHOR, CLEAR_HELPER, "clear helper anchor"),
        (STALE_ANCHOR, CAS_PRIMITIVES, "CAS primitive anchor"),
    )
    for old, new, label in replacements:
        source = replace_exact(source, old, new, label)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/gateway/drain_control.py",
        help="Hermes gateway drain-control module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
