#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

output="$(cat)"
if [[ "$output" =~ (^|[^0-9.])([0-9]+\.[0-9]+\.[0-9]+)([^0-9.]|$) ]]; then
  printf '%s\n' "${BASH_REMATCH[2]}"
  exit 0
fi

exit 1
