// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function fileIdentityAndBytes(filePath: string): [number, Buffer] {
  const fd = fs.openSync(filePath, "r");
  try {
    return [fs.fstatSync(fd).ino, fs.readFileSync(fd)];
  } finally {
    fs.closeSync(fd);
  }
}
