// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

type OpenShellPins = Readonly<{
  installVersion: string;
  maxVersion: string;
  minVersion: string;
}>;

type OpenClawPins = Readonly<{
  minVersion: string;
  npmIntegrity: string;
  tarball: string;
  version: string;
}>;

type HermesPins = Readonly<{
  expectedVersion: string;
  npmIntegrity: string;
  tag: string;
  tarballSha256: string;
}>;

type DependencyPins = Readonly<{
  hermes: HermesPins;
  openclaw: OpenClawPins;
  openshell: OpenShellPins;
  schemaVersion: 1;
}>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PIN_FILE = "dependency-pins.yaml";
const OPENCLAW_VERSION_ARG_SUFFIX_RE = /[.-]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  section: Record<string, unknown>,
  key: string,
  failures: string[],
  label: string,
): string {
  const value = section[key];
  if (typeof value === "string" && value.length > 0) return value;
  failures.push(`${PIN_FILE}: ${label}.${key} must be a non-empty string`);
  return "";
}

export function readDependencyPins(rootDir: string = REPO_ROOT): {
  failures: string[];
  pins: DependencyPins | null;
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(path.join(rootDir, PIN_FILE), "utf8"));
  } catch (error) {
    return {
      failures: [`${PIN_FILE}: failed to read or parse (${(error as Error).message})`],
      pins: null,
    };
  }

  const failures: string[] = [];
  if (!isRecord(parsed)) {
    return { failures: [`${PIN_FILE}: root document must be a mapping`], pins: null };
  }
  if (parsed.schemaVersion !== 1) {
    failures.push(`${PIN_FILE}: schemaVersion must be 1`);
  }

  const openshell = isRecord(parsed.openshell) ? parsed.openshell : null;
  const openclaw = isRecord(parsed.openclaw) ? parsed.openclaw : null;
  const hermes = isRecord(parsed.hermes) ? parsed.hermes : null;
  if (!openshell) failures.push(`${PIN_FILE}: openshell section is required`);
  if (!openclaw) failures.push(`${PIN_FILE}: openclaw section is required`);
  if (!hermes) failures.push(`${PIN_FILE}: hermes section is required`);

  const pins = {
    schemaVersion: 1 as const,
    openshell: {
      installVersion: openshell
        ? requireString(openshell, "installVersion", failures, "openshell")
        : "",
      minVersion: openshell ? requireString(openshell, "minVersion", failures, "openshell") : "",
      maxVersion: openshell ? requireString(openshell, "maxVersion", failures, "openshell") : "",
    },
    openclaw: {
      version: openclaw ? requireString(openclaw, "version", failures, "openclaw") : "",
      minVersion: openclaw ? requireString(openclaw, "minVersion", failures, "openclaw") : "",
      npmIntegrity: openclaw ? requireString(openclaw, "npmIntegrity", failures, "openclaw") : "",
      tarball: openclaw ? requireString(openclaw, "tarball", failures, "openclaw") : "",
    },
    hermes: {
      tag: hermes ? requireString(hermes, "tag", failures, "hermes") : "",
      expectedVersion: hermes ? requireString(hermes, "expectedVersion", failures, "hermes") : "",
      tarballSha256: hermes ? requireString(hermes, "tarballSha256", failures, "hermes") : "",
      npmIntegrity: hermes ? requireString(hermes, "npmIntegrity", failures, "hermes") : "",
    },
  };

  return { failures, pins: failures.length === 0 ? pins : null };
}

function readText(rootDir: string, relativePath: string, failures: string[]): string {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    failures.push(`${relativePath}: failed to read (${(error as Error).message})`);
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSingle(source: string, pattern: RegExp, label: string, failures: string[]): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    failures.push(`${label}: expected exactly one match`);
    return "";
  }
  return matches[0][1];
}

/** Normalize YAML scalar values into strings for version and integrity comparisons. */
function scalarToString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Parse a governed YAML file into a mapping so checks do not depend on formatting. */
function parseYamlMapping(
  source: string,
  label: string,
  failures: string[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    failures.push(`${label}: failed to parse YAML (${(error as Error).message})`);
    return null;
  }
  if (!isRecord(parsed)) {
    failures.push(`${label}: YAML document must be a mapping`);
    return null;
  }
  return parsed;
}

/** Read one top-level scalar field from a parsed YAML mapping. */
function extractYamlString(
  document: Record<string, unknown> | null,
  key: string,
  label: string,
  failures: string[],
): string {
  const value = document?.[key];
  const scalar = scalarToString(value);
  if (scalar === null || scalar.length === 0) {
    failures.push(`${label}: expected scalar YAML value at ${key}`);
    return "";
  }
  return scalar;
}

/** Read one string field from a governed JSON manifest. */
function extractJsonString(source: string, key: string, label: string, failures: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    failures.push(`${label}: failed to parse JSON (${(error as Error).message})`);
    return "";
  }
  if (!isRecord(parsed)) {
    failures.push(`${label}: JSON document must be an object`);
    return "";
  }
  const value = parsed[key];
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${label}: expected non-empty string field ${key}`);
    return "";
  }
  return value;
}

function extractArg(source: string, argName: string, label: string, failures: string[]): string {
  return extractSingle(
    source,
    new RegExp(`^ARG\\s+${escapeRegExp(argName)}=([^\\s]+)\\s*$`, "gm"),
    label,
    failures,
  );
}

function compare(actual: string, expected: string, label: string, failures: string[]): void {
  if (actual && expected && actual !== expected) {
    failures.push(`${label}: expected ${expected}, found ${actual}`);
  }
}

function openclawArgSuffix(version: string): string {
  return version.replace(OPENCLAW_VERSION_ARG_SUFFIX_RE, "_");
}

/** Verify OpenShell pins against installer, blueprint, and credential-boundary surfaces. */
function verifyOpenShellPins(
  pins: OpenShellPins,
  sources: {
    blueprint: Record<string, unknown> | null;
    brevLaunchable: string;
    credentialBoundary: string;
    mcpBridgeValidation: string;
  },
  failures: string[],
): void {
  compare(
    extractYamlString(
      sources.blueprint,
      "min_openshell_version",
      "blueprint min_openshell_version",
      failures,
    ),
    pins.minVersion,
    "blueprint min_openshell_version",
    failures,
  );
  compare(
    extractYamlString(
      sources.blueprint,
      "max_openshell_version",
      "blueprint max_openshell_version",
      failures,
    ),
    pins.maxVersion,
    "blueprint max_openshell_version",
    failures,
  );
  compare(
    extractSingle(
      sources.brevLaunchable,
      /^\s*stable \| auto\) OPENSHELL_VERSION="v([^"]+)" ;;\s*$/gm,
      "Brev launchable stable OpenShell default",
      failures,
    ),
    pins.installVersion,
    "Brev launchable stable OpenShell default",
    failures,
  );
  compare(
    extractJsonString(
      sources.credentialBoundary,
      "openshellVersion",
      "OpenShell credential-boundary manifest version",
      failures,
    ),
    pins.installVersion,
    "OpenShell credential-boundary manifest version",
    failures,
  );
  compare(
    extractSingle(
      sources.mcpBridgeValidation,
      /openshell-child-visible-credentials\.v([0-9]+\.[0-9]+\.[0-9]+)\.json/,
      "OpenShell credential-boundary import",
      failures,
    ),
    pins.installVersion,
    "OpenShell credential-boundary import",
    failures,
  );
}

/** Verify OpenClaw pins against blueprint, Dockerfile, and manifest surfaces. */
function verifyOpenClawPins(
  pins: OpenClawPins,
  sources: {
    blueprint: Record<string, unknown> | null;
    dockerfile: string;
    dockerfileBase: string;
    manifest: Record<string, unknown> | null;
  },
  failures: string[],
): void {
  compare(
    extractYamlString(
      sources.blueprint,
      "min_openclaw_version",
      "blueprint min_openclaw_version",
      failures,
    ),
    pins.minVersion,
    "blueprint min_openclaw_version",
    failures,
  );
  compare(
    extractYamlString(
      sources.manifest,
      "expected_version",
      "OpenClaw manifest expected_version",
      failures,
    ),
    pins.version,
    "OpenClaw manifest expected_version",
    failures,
  );
  const openclawVersionArg = `OPENCLAW_${openclawArgSuffix(pins.version)}`;
  for (const [label, source] of [
    ["Dockerfile", sources.dockerfile],
    ["Dockerfile.base", sources.dockerfileBase],
  ] as const) {
    compare(
      extractArg(source, "OPENCLAW_VERSION", `${label} OPENCLAW_VERSION`, failures),
      pins.version,
      `${label} OPENCLAW_VERSION`,
      failures,
    );
    compare(
      extractArg(
        source,
        `${openclawVersionArg}_INTEGRITY`,
        `${label} ${openclawVersionArg}_INTEGRITY`,
        failures,
      ),
      pins.npmIntegrity,
      `${label} ${openclawVersionArg}_INTEGRITY`,
      failures,
    );
    compare(
      extractArg(
        source,
        `${openclawVersionArg}_TARBALL`,
        `${label} ${openclawVersionArg}_TARBALL`,
        failures,
      ),
      pins.tarball,
      `${label} ${openclawVersionArg}_TARBALL`,
      failures,
    );
  }
}

/** Verify Hermes pins against Dockerfile and manifest surfaces. */
function verifyHermesPins(
  pins: HermesPins,
  sources: {
    dockerfileBase: string;
    manifest: Record<string, unknown> | null;
  },
  failures: string[],
): void {
  compare(
    extractArg(
      sources.dockerfileBase,
      "HERMES_VERSION",
      "Hermes Dockerfile.base HERMES_VERSION",
      failures,
    ),
    pins.tag,
    "Hermes Dockerfile.base HERMES_VERSION",
    failures,
  );
  compare(
    extractArg(
      sources.dockerfileBase,
      "HERMES_SEMVER",
      "Hermes Dockerfile.base HERMES_SEMVER",
      failures,
    ),
    pins.expectedVersion,
    "Hermes Dockerfile.base HERMES_SEMVER",
    failures,
  );
  compare(
    extractArg(
      sources.dockerfileBase,
      "HERMES_TARBALL_SHA256",
      "Hermes Dockerfile.base HERMES_TARBALL_SHA256",
      failures,
    ),
    pins.tarballSha256,
    "Hermes Dockerfile.base HERMES_TARBALL_SHA256",
    failures,
  );
  compare(
    extractArg(
      sources.dockerfileBase,
      "HERMES_NPM_INTEGRITY",
      "Hermes Dockerfile.base HERMES_NPM_INTEGRITY",
      failures,
    ),
    pins.npmIntegrity,
    "Hermes Dockerfile.base HERMES_NPM_INTEGRITY",
    failures,
  );
  compare(
    extractYamlString(
      sources.manifest,
      "expected_version",
      "Hermes manifest expected_version",
      failures,
    ),
    pins.expectedVersion,
    "Hermes manifest expected_version",
    failures,
  );
}

export function verifyDependencyPins(rootDir: string = REPO_ROOT): string[] {
  const { failures, pins } = readDependencyPins(rootDir);
  if (!pins) return failures;

  const blueprint = readText(rootDir, "nemoclaw-blueprint/blueprint.yaml", failures);
  const brevLaunchable = readText(rootDir, "scripts/brev-launchable-ci-cpu.sh", failures);
  const openclawManifest = readText(rootDir, "agents/openclaw/manifest.yaml", failures);
  const hermesManifest = readText(rootDir, "agents/hermes/manifest.yaml", failures);
  const dockerfile = readText(rootDir, "Dockerfile", failures);
  const dockerfileBase = readText(rootDir, "Dockerfile.base", failures);
  const hermesDockerfileBase = readText(rootDir, "agents/hermes/Dockerfile.base", failures);
  const credentialBoundary = readText(
    rootDir,
    `src/lib/actions/sandbox/openshell-child-visible-credentials.v${pins.openshell.installVersion}.json`,
    failures,
  );
  const mcpBridgeValidation = readText(
    rootDir,
    "src/lib/actions/sandbox/mcp-bridge-validation.ts",
    failures,
  );

  const blueprintYaml = parseYamlMapping(blueprint, "nemoclaw-blueprint/blueprint.yaml", failures);
  const openclawManifestYaml = parseYamlMapping(
    openclawManifest,
    "agents/openclaw/manifest.yaml",
    failures,
  );
  const hermesManifestYaml = parseYamlMapping(
    hermesManifest,
    "agents/hermes/manifest.yaml",
    failures,
  );

  verifyOpenShellPins(
    pins.openshell,
    { blueprint: blueprintYaml, brevLaunchable, credentialBoundary, mcpBridgeValidation },
    failures,
  );
  verifyOpenClawPins(
    pins.openclaw,
    { blueprint: blueprintYaml, dockerfile, dockerfileBase, manifest: openclawManifestYaml },
    failures,
  );
  verifyHermesPins(
    pins.hermes,
    { dockerfileBase: hermesDockerfileBase, manifest: hermesManifestYaml },
    failures,
  );

  return failures;
}

function main(): void {
  const failures = verifyDependencyPins();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Dependency pins match their governed files.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
