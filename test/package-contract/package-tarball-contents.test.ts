// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPackageFixture } from "./helpers/package-fixture";

type PackFile = {
  readonly path: string;
  readonly size: number;
};

type PackResult = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly PackFile[];
};

describe("package tarball content contract", () => {
  it("excludes tests, development configs, and untracked artifacts from the packed tarball", () => {
    const fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-tarball-contract-",
      entries: [
        "bin",
        "dist",
        "agents/hermes/host",
        "agents/nemocua",
        "agents/openclaw",
        "nemoclaw/openclaw.plugin.json",
        "nemoclaw/package.json",
        "schemas",
      ],
    });

    try {
      const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: fixtureRoot,
        encoding: "utf8",
        timeout: 30_000,
      });

      const parsed = JSON.parse(output) as PackResult[];
      expect(parsed).toHaveLength(1);

      const packedFiles = parsed[0]!.files.map((file) => file.path);

      // Must not include test files
      const testFiles = packedFiles.filter(
        (filePath) =>
          filePath.endsWith(".test.ts") ||
          filePath.endsWith(".test.js") ||
          filePath.endsWith(".spec.ts") ||
          filePath.includes("__tests__"),
      );
      expect(testFiles).toEqual([]);

      // Must not include development configurations in package root
      const devConfigFiles = packedFiles.filter(
        (filePath) =>
          filePath === "vitest.config.ts" ||
          filePath === "oxlint.config.ts" ||
          filePath === "tsconfig.json" ||
          filePath === "tsconfig.cli.json",
      );
      expect(devConfigFiles).toEqual([]);

      // Must include essential runtime binaries and entry points
      expect(packedFiles).toContain("bin/nemoclaw.js");
      expect(packedFiles).toContain("bin/nemohermes.js");
    } finally {
      if (existsSync(fixtureRoot)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
