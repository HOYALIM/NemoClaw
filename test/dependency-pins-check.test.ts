// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readDependencyPins, verifyDependencyPins } from "../scripts/checks/dependency-pins";

const OPENCLAW_INTEGRITY =
  "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==";
const OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz";
const HERMES_INTEGRITY =
  "sha512-PzSJiYqmwpTudmakYs2oCJ57OW3VwEJYf8buTuKvuRvcYEUf/KOTu2dD6pLf2XYgDKErpvcDaoSAJ1nGCyvzAA==";

function writeFixture(root: string, overrides: Partial<Record<string, string>> = {}): void {
  const files = {
    "dependency-pins.yaml": `
schemaVersion: 1
openshell:
  installVersion: "${overrides.openshellInstallVersion ?? "0.0.72"}"
  minVersion: "${overrides.openshellPinMinVersion ?? "0.0.72"}"
  maxVersion: "${overrides.openshellPinMaxVersion ?? "0.0.72"}"
openclaw:
  version: "${overrides.openclawPinVersion ?? "2026.6.10"}"
  minVersion: "${overrides.openclawPinMinVersion ?? "2026.3.11"}"
  npmIntegrity: "${overrides.openclawPinNpmIntegrity ?? OPENCLAW_INTEGRITY}"
  tarball: "${overrides.openclawPinTarball ?? OPENCLAW_TARBALL}"
hermes:
  tag: "${overrides.hermesPinTag ?? "v2026.6.19"}"
  expectedVersion: "${overrides.hermesPinExpectedVersion ?? "0.17.0"}"
  tarballSha256: "${overrides.hermesPinTarballSha256 ?? "69b805ec0a7a7be880068ba8a3b17479d7ba29f0cac0a2e9c6692c02f346ba91"}"
  npmIntegrity: "${overrides.hermesPinNpmIntegrity ?? HERMES_INTEGRITY}"
`,
    "nemoclaw-blueprint/blueprint.yaml": `
min_openshell_version: '${overrides.minOpenshellVersion ?? "0.0.72"}' # parser handles comments
max_openshell_version: '0.0.72'
min_openclaw_version: '2026.3.11'
`,
    "scripts/brev-launchable-ci-cpu.sh": `
case "$NEMOCLAW_REF" in
    stable | auto) OPENSHELL_VERSION="v0.0.72" ;;
esac
`,
    "scripts/install-openshell.sh": `
MIN_VERSION="${overrides.installerMinVersion ?? "0.0.72"}"
MAX_VERSION="0.0.72"
PIN_VERSION="$MAX_VERSION"
DEV_MIN_VERSION="${overrides.installerDevMinVersion ?? "0.0.72"}"
`,
    "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.72.json": `
{
  "openshellVersion"
    : "0.0.72"
}
`,
    "src/lib/actions/sandbox/mcp-bridge-validation.ts": `
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.72.json";
`,
    "agents/hermes/Dockerfile": `
COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.72.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v${overrides.hermesDockerfileBoundaryVersion ?? "0.0.72"}.json
`,
    "agents/hermes/mcp-config-transaction.py": `
BOUNDARY_MANIFEST_NAME = "openshell-child-visible-credentials.v${overrides.hermesTransactionBoundaryVersion ?? "0.0.72"}.json"
if manifest.get("openshellVersion") != "${overrides.hermesTransactionExpectedVersion ?? "0.0.72"}":
    raise RuntimeError("invalid")
`,
    "scripts/update-hermes-agent.sh": `
"openshell-child-visible-credentials.v${overrides.hermesUpdateBoundaryVersion ?? "0.0.72"}.json"
`,
    Dockerfile: `
ARG OPENCLAW_VERSION=${overrides.openclawDockerfileVersion ?? "2026.6.10"}
ARG OPENCLAW_2026_6_10_INTEGRITY=${OPENCLAW_INTEGRITY}
ARG OPENCLAW_2026_6_10_TARBALL=${OPENCLAW_TARBALL}
`,
    "Dockerfile.base": `
ARG OPENCLAW_VERSION=2026.6.10
ARG OPENCLAW_2026_6_10_INTEGRITY=${OPENCLAW_INTEGRITY}
ARG OPENCLAW_2026_6_10_TARBALL=${OPENCLAW_TARBALL}
`,
    "agents/openclaw/manifest.yaml": `
expected_version: '2026.6.10' # parser handles comments
`,
    "agents/hermes/Dockerfile.base": `
ARG HERMES_VERSION=v2026.6.19
ARG HERMES_SEMVER=0.17.0
ARG HERMES_TARBALL_SHA256=69b805ec0a7a7be880068ba8a3b17479d7ba29f0cac0a2e9c6692c02f346ba91
ARG HERMES_NPM_INTEGRITY=${overrides.hermesNpmIntegrity ?? HERMES_INTEGRITY}
`,
    "agents/hermes/manifest.yaml": `
expected_version: '0.17.0' # parser handles comments
`,
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents.trimStart());
  }
}

describe("dependency pin drift check", () => {
  it("accepts matching OpenShell, OpenClaw, and Hermes pins (#5242)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dependency-pins-"));
    try {
      writeFixture(root);

      expect(verifyDependencyPins(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports governed file drift with the exact stale surface (#5242)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dependency-pins-drift-"));
    try {
      writeFixture(root, {
        hermesNpmIntegrity: "sha512-drift",
        hermesDockerfileBoundaryVersion: "0.0.71",
        hermesTransactionBoundaryVersion: "0.0.71",
        hermesTransactionExpectedVersion: "0.0.71",
        hermesUpdateBoundaryVersion: "0.0.71",
        installerMinVersion: "0.0.71",
        minOpenshellVersion: "0.0.71",
        openclawDockerfileVersion: "2026.6.9",
      });

      expect(verifyDependencyPins(root)).toEqual([
        "OpenShell installer MIN_VERSION: expected 0.0.72, found 0.0.71",
        "blueprint min_openshell_version: expected 0.0.72, found 0.0.71",
        "Hermes Dockerfile credential-boundary manifest version: expected 0.0.72, found 0.0.71",
        "Hermes MCP transaction credential-boundary manifest version: expected 0.0.72, found 0.0.71",
        "Hermes MCP transaction expected OpenShell version: expected 0.0.72, found 0.0.71",
        "Hermes update script credential-boundary manifest version: expected 0.0.72, found 0.0.71",
        "Dockerfile OPENCLAW_VERSION: expected 2026.6.10, found 2026.6.9",
        `Hermes Dockerfile.base HERMES_NPM_INTEGRITY: expected ${HERMES_INTEGRITY}, found sha512-drift`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a stale OpenShell dev-channel minimum (#5242)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dependency-pins-dev-min-"));
    try {
      writeFixture(root, { installerDevMinVersion: "0.0.71" });

      expect(verifyDependencyPins(root)).toEqual([
        "OpenShell installer DEV_MIN_VERSION: expected 0.0.72, found 0.0.71",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "path-like OpenShell install version",
      overrides: { openshellInstallVersion: "../0.0.72" },
      failure: "dependency-pins.yaml: openshell.installVersion must match X.Y.Z",
    },
    {
      name: "short OpenShell minimum version",
      overrides: { openshellPinMinVersion: "0.0" },
      failure: "dependency-pins.yaml: openshell.minVersion must match X.Y.Z",
    },
    {
      name: "path-like OpenClaw version",
      overrides: { openclawPinVersion: "2026/6/10" },
      failure: "dependency-pins.yaml: openclaw.version must match X.Y.Z",
    },
    {
      name: "short OpenClaw minimum version",
      overrides: { openclawPinMinVersion: "2026.3" },
      failure: "dependency-pins.yaml: openclaw.minVersion must match X.Y.Z",
    },
    {
      name: "unprefixed Hermes tag",
      overrides: { hermesPinTag: "2026.6.19" },
      failure: "dependency-pins.yaml: hermes.tag must be a v-prefixed numeric dotted version",
    },
    {
      name: "short Hermes package version",
      overrides: { hermesPinExpectedVersion: "0.17" },
      failure: "dependency-pins.yaml: hermes.expectedVersion must match X.Y.Z",
    },
    {
      name: "malformed OpenClaw SRI",
      overrides: { openclawPinNpmIntegrity: "sha512-not-canonical" },
      failure: "dependency-pins.yaml: openclaw.npmIntegrity must be a canonical sha512 SRI digest",
    },
    {
      name: "malformed Hermes SRI",
      overrides: { hermesPinNpmIntegrity: "sha512-not-canonical" },
      failure: "dependency-pins.yaml: hermes.npmIntegrity must be a canonical sha512 SRI digest",
    },
    {
      name: "short Hermes SHA-256",
      overrides: { hermesPinTarballSha256: "abc123" },
      failure:
        "dependency-pins.yaml: hermes.tarballSha256 must be a lowercase 64-character SHA-256",
    },
    {
      name: "wrong OpenClaw tarball host",
      overrides: { openclawPinTarball: "https://example.com/openclaw-2026.6.10.tgz" },
      failure: `dependency-pins.yaml: openclaw.tarball must equal ${OPENCLAW_TARBALL}`,
    },
    {
      name: "wrong OpenClaw tarball package",
      overrides: {
        openclawPinTarball: "https://registry.npmjs.org/not-openclaw/-/not-openclaw-2026.6.10.tgz",
      },
      failure: `dependency-pins.yaml: openclaw.tarball must equal ${OPENCLAW_TARBALL}`,
    },
    {
      name: "wrong OpenClaw tarball version",
      overrides: {
        openclawPinTarball: "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.9.tgz",
      },
      failure: `dependency-pins.yaml: openclaw.tarball must equal ${OPENCLAW_TARBALL}`,
    },
  ])("rejects $name before governed-file reads (#5242)", ({ overrides, failure }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dependency-pins-invalid-"));
    try {
      writeFixture(root, overrides);

      expect(readDependencyPins(root)).toEqual({ failures: [failure], pins: null });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
