// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS = ["openshell", "openclaw", "hermes", "dcode"] as const;
export type CandidateComponent = (typeof COMPONENTS)[number];

export type Artifact = {
  digest: string;
  digestAlgorithm: "sha256" | "sha512";
  kind: "archive" | "npm" | "wheel";
  name: string;
  url: string;
};

export type CandidateReceipt = {
  artifacts: Artifact[];
  component: CandidateComponent;
  nemoclawSha: string;
  officialSource: string;
  requestedCandidate: string;
  resolutionId: string;
  resolvedCandidate: string;
  resolvedCommit?: string;
  schemaVersion: 1;
};

export type CandidatePlan = {
  component: CandidateComponent;
  deterministic: Array<{
    id: DeterministicLane;
    reason: string;
    status: "selected" | "skipped";
  }>;
  live: Array<{
    id: string;
    reason: string;
    selector: "job" | "target";
    status: "skipped";
  }>;
  schemaVersion: 1;
};

type LaneResult = {
  conclusion: "failure" | "success";
  lane: DeterministicLane;
  observedOutput?: string;
  observedVersion?: string;
  resolutionId: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type DeterministicLane =
  | "source-unit"
  | "integration"
  | "installer"
  | "package-contract"
  | "plugin"
  | "e2e-support";

const FULL_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z.-]+)?$/;
const HERMES_TAG = /^v[0-9]+(?:\.[0-9]+){2}$/;
const DIGEST = /^[a-f0-9]+$/;
const OFFICIAL_HOSTS = new Set([
  "api.github.com",
  "codeload.github.com",
  "files.pythonhosted.org",
  "github.com",
  "registry.npmjs.org",
]);
const DOWNLOAD_HOSTS = new Set([...OFFICIAL_HOSTS, "release-assets.githubusercontent.com"]);
const MAX_DOWNLOAD_REDIRECTS = 5;
const ALL_LANES: DeterministicLane[] = [
  "source-unit",
  "integration",
  "installer",
  "package-contract",
  "plugin",
  "e2e-support",
];

const SELECTED_LANES: Record<CandidateComponent, ReadonlySet<DeterministicLane>> = {
  openshell: new Set(["source-unit", "integration", "installer", "e2e-support"]),
  openclaw: new Set(["source-unit", "integration", "package-contract", "plugin", "e2e-support"]),
  hermes: new Set(["source-unit", "integration", "e2e-support"]),
  dcode: new Set(["source-unit", "integration", "e2e-support"]),
};

const LIVE_SELECTORS: Record<
  CandidateComponent,
  ReadonlyArray<{ id: string; selector: "job" | "target" }>
> = {
  openshell: [
    { id: "full-e2e", selector: "job" },
    { id: "openshell-gateway-auth-contract", selector: "job" },
  ],
  openclaw: [
    { id: "full-e2e", selector: "job" },
    { id: "openclaw-skill-cli", selector: "job" },
  ],
  hermes: [{ id: "hermes-e2e", selector: "job" }],
  dcode: [{ id: "ubuntu-repo-cloud-langchain-deepagents-code", selector: "target" }],
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertComponent(value: string): asserts value is CandidateComponent {
  if (!COMPONENTS.includes(value as CandidateComponent)) {
    throw new Error(`component must be one of: ${COMPONENTS.join(", ")}`);
  }
}

function assertCandidate(component: CandidateComponent, candidate: string): void {
  if (candidate.length > 128 || candidate.includes("/") || /[\x00-\x20\x7f]/u.test(candidate)) {
    throw new Error("candidate contains unsafe characters");
  }
  if (component === "hermes") {
    if (!HERMES_TAG.test(candidate)) throw new Error("Hermes candidate must match vX.Y.Z");
    return;
  }
  const normalized = component === "openshell" ? candidate.replace(/^v/u, "") : candidate;
  if (!VERSION.test(normalized)) {
    throw new Error(`${component} candidate must be an exact version`);
  }
}

function assertOfficialUrl(raw: string, expectedPathPrefix: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname)) {
    throw new Error(`candidate artifact is not on an approved official HTTPS host: ${raw}`);
  }
  if (!url.pathname.startsWith(expectedPathPrefix)) {
    throw new Error(`candidate artifact has unexpected official-source path: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `candidate artifact URL must not contain credentials, query, or fragment: ${raw}`,
    );
  }
  return url;
}

async function fetchJson(fetcher: FetchLike, url: string, token?: string): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json, application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`official metadata request failed (${response.status}): ${url}`);
  return response.json();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function artifact(input: Artifact, expectedPathPrefix: string): Artifact {
  const url = assertOfficialUrl(input.url, expectedPathPrefix);
  if (!DIGEST.test(input.digest)) throw new Error(`${input.name} has an invalid digest`);
  const expectedLength = input.digestAlgorithm === "sha256" ? 64 : 128;
  if (input.digest.length !== expectedLength) {
    throw new Error(`${input.name} has an invalid ${input.digestAlgorithm} digest`);
  }
  return { ...input, url: url.href };
}

async function resolveOpenShell(
  candidate: string,
  fetcher: FetchLike,
  token?: string,
): Promise<Omit<CandidateReceipt, "nemoclawSha" | "resolutionId" | "schemaVersion">> {
  const version = candidate.replace(/^v/u, "");
  const tag = `v${version}`;
  const metadata = record(
    await fetchJson(
      fetcher,
      `https://api.github.com/repos/NVIDIA/OpenShell/releases/tags/${tag}`,
      token,
    ),
    "OpenShell release",
  );
  if (metadata.draft === true) throw new Error("OpenShell candidate release is a draft");
  if (stringField(metadata, "tag_name", "OpenShell release") !== tag) {
    throw new Error("OpenShell release tag does not match the requested candidate");
  }
  if (!Array.isArray(metadata.assets)) throw new Error("OpenShell release assets must be an array");
  const name = "openshell-x86_64-unknown-linux-musl.tar.gz";
  const assetMetadata = metadata.assets
    .map((item) => record(item, "OpenShell asset"))
    .find((item) => item.name === name);
  if (!assetMetadata) throw new Error(`OpenShell release is missing ${name}`);
  const digest = stringField(assetMetadata, "digest", "OpenShell asset");
  if (!digest.startsWith("sha256:"))
    throw new Error("OpenShell asset is missing SHA-256 provenance");
  return {
    artifacts: [
      artifact(
        {
          digest: digest.slice("sha256:".length),
          digestAlgorithm: "sha256",
          kind: "archive",
          name,
          url: stringField(assetMetadata, "browser_download_url", "OpenShell asset"),
        },
        `/NVIDIA/OpenShell/releases/download/${tag}/`,
      ),
    ],
    component: "openshell",
    officialSource: `github:NVIDIA/OpenShell:release:${String(metadata.id)}`,
    requestedCandidate: candidate,
    resolvedCandidate: version,
  };
}

function npmArtifact(metadata: Record<string, unknown>, packageName: string): Artifact {
  const dist = record(metadata.dist, `${packageName} dist`);
  const integrity = stringField(dist, "integrity", `${packageName} dist`);
  if (!integrity.startsWith("sha512-"))
    throw new Error(`${packageName} requires sha512 npm integrity`);
  let digest: string;
  try {
    digest = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  } catch {
    throw new Error(`${packageName} has invalid npm integrity`);
  }
  return artifact(
    {
      digest,
      digestAlgorithm: "sha512",
      kind: "npm",
      name: `${packageName}-${stringField(metadata, "version", packageName)}.tgz`,
      url: stringField(dist, "tarball", `${packageName} dist`),
    },
    `/${packageName}/-/`,
  );
}

async function resolveNpm(
  component: "openclaw",
  candidate: string,
  fetcher: FetchLike,
): Promise<Omit<CandidateReceipt, "nemoclawSha" | "resolutionId" | "schemaVersion">> {
  const packageName = component;
  const metadata = record(
    await fetchJson(fetcher, `https://registry.npmjs.org/${packageName}/${candidate}`),
    `${packageName} metadata`,
  );
  const resolvedCandidate = stringField(metadata, "version", `${packageName} metadata`);
  if (resolvedCandidate !== candidate)
    throw new Error(`${packageName} metadata resolved a different version`);
  return {
    artifacts: [npmArtifact(metadata, packageName)],
    component,
    officialSource: `npm:${packageName}@${resolvedCandidate}`,
    requestedCandidate: candidate,
    resolvedCandidate,
  };
}

async function peelGitTag(fetcher: FetchLike, candidate: string, token?: string): Promise<string> {
  let object = record(
    record(
      await fetchJson(
        fetcher,
        `https://api.github.com/repos/NousResearch/hermes-agent/git/ref/tags/${candidate}`,
        token,
      ),
      "Hermes tag ref",
    ).object,
    "Hermes tag object",
  );
  for (let depth = 0; depth < 2 && object.type === "tag"; depth += 1) {
    const tag = record(
      await fetchJson(fetcher, stringField(object, "url", "Hermes tag object"), token),
      "Hermes annotated tag",
    );
    object = record(tag.object, "Hermes annotated tag object");
  }
  if (object.type !== "commit") throw new Error("Hermes tag does not resolve to a commit");
  const commit = stringField(object, "sha", "Hermes tag object");
  if (!FULL_SHA.test(commit)) throw new Error("Hermes tag resolved an invalid commit SHA");
  return commit;
}

async function resolveHermes(
  candidate: string,
  fetcher: FetchLike,
  token?: string,
): Promise<Omit<CandidateReceipt, "nemoclawSha" | "resolutionId" | "schemaVersion">> {
  const release = record(
    await fetchJson(
      fetcher,
      `https://api.github.com/repos/NousResearch/hermes-agent/releases/tags/${candidate}`,
      token,
    ),
    "Hermes release",
  );
  if (release.draft === true) throw new Error("Hermes candidate release is a draft");
  if (stringField(release, "tag_name", "Hermes release") !== candidate) {
    throw new Error("Hermes release tag does not match the requested candidate");
  }
  const commit = await peelGitTag(fetcher, candidate, token);
  const pyprojectResponse = await fetcher(
    `https://raw.githubusercontent.com/NousResearch/hermes-agent/${commit}/pyproject.toml`,
    { redirect: "error" },
  );
  if (!pyprojectResponse.ok)
    throw new Error("failed to read Hermes package version at resolved commit");
  const pyproject = await pyprojectResponse.text();
  const version = pyproject.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (!version || !VERSION.test(version))
    throw new Error("Hermes pyproject has no exact package version");
  const npmMetadata = record(
    await fetchJson(fetcher, `https://registry.npmjs.org/hermes-agent/${version}`),
    "Hermes npm metadata",
  );
  if (stringField(npmMetadata, "version", "Hermes npm metadata") !== version) {
    throw new Error("Hermes npm package version does not match the resolved source");
  }
  const wheel = await resolvePypiWheel("hermes-agent", version, fetcher);
  return {
    artifacts: [npmArtifact(npmMetadata, "hermes-agent"), wheel],
    component: "hermes",
    officialSource: `github:NousResearch/hermes-agent:release:${String(release.id)}`,
    requestedCandidate: candidate,
    resolvedCandidate: version,
    resolvedCommit: commit,
  };
}

async function resolvePypiWheel(
  packageName: string,
  version: string,
  fetcher: FetchLike,
): Promise<Artifact> {
  const metadata = record(
    await fetchJson(fetcher, `https://pypi.org/pypi/${packageName}/${version}/json`),
    `${packageName} PyPI metadata`,
  );
  const info = record(metadata.info, `${packageName} PyPI info`);
  if (stringField(info, "name", `${packageName} PyPI info`).toLowerCase() !== packageName) {
    throw new Error(`PyPI returned a different package for ${packageName}`);
  }
  if (stringField(info, "version", `${packageName} PyPI info`) !== version) {
    throw new Error(`PyPI resolved a different ${packageName} version`);
  }
  if (!Array.isArray(metadata.urls)) throw new Error(`${packageName} PyPI files must be an array`);
  const wheel = metadata.urls
    .map((item) => record(item, `${packageName} PyPI file`))
    .find((item) => item.packagetype === "bdist_wheel" && item.yanked !== true);
  if (!wheel) throw new Error(`${packageName} release has no non-yanked wheel`);
  const digests = record(wheel.digests, `${packageName} PyPI file digests`);
  return artifact(
    {
      digest: stringField(digests, "sha256", `${packageName} PyPI file digests`),
      digestAlgorithm: "sha256",
      kind: "wheel",
      name: stringField(wheel, "filename", `${packageName} PyPI file`),
      url: stringField(wheel, "url", `${packageName} PyPI file`),
    },
    "/packages/",
  );
}

async function resolveDcode(
  candidate: string,
  fetcher: FetchLike,
): Promise<Omit<CandidateReceipt, "nemoclawSha" | "resolutionId" | "schemaVersion">> {
  const wheel = await resolvePypiWheel("deepagents-code", candidate, fetcher);
  return {
    artifacts: [wheel],
    component: "dcode",
    officialSource: `pypi:deepagents-code==${candidate}`,
    requestedCandidate: candidate,
    resolvedCandidate: candidate,
  };
}

export async function resolveCandidate(input: {
  candidate: string;
  component: string;
  fetcher?: FetchLike;
  githubToken?: string;
  nemoclawSha: string;
}): Promise<CandidateReceipt> {
  assertComponent(input.component);
  if (!FULL_SHA.test(input.nemoclawSha)) throw new Error("NemoClaw ref must resolve to a full SHA");
  assertCandidate(input.component, input.candidate);
  const fetcher = input.fetcher ?? fetch;
  const resolved =
    input.component === "openshell"
      ? await resolveOpenShell(input.candidate, fetcher, input.githubToken)
      : input.component === "openclaw"
        ? await resolveNpm(input.component, input.candidate, fetcher)
        : input.component === "hermes"
          ? await resolveHermes(input.candidate, fetcher, input.githubToken)
          : await resolveDcode(input.candidate, fetcher);
  const receiptWithoutId = {
    ...resolved,
    nemoclawSha: input.nemoclawSha,
    schemaVersion: 1 as const,
  };
  return {
    ...receiptWithoutId,
    resolutionId: sha256(stableJson(receiptWithoutId)),
  };
}

function parseArtifact(
  value: unknown,
  component: CandidateComponent,
  resolvedCandidate: string,
  index: number,
): Artifact {
  const input = record(value, `candidate artifact ${index}`);
  const digestAlgorithm = stringField(input, "digestAlgorithm", `candidate artifact ${index}`);
  if (digestAlgorithm !== "sha256" && digestAlgorithm !== "sha512") {
    throw new Error(`candidate artifact ${index} has an invalid digest algorithm`);
  }
  const kind = stringField(input, "kind", `candidate artifact ${index}`);
  if (kind !== "archive" && kind !== "npm" && kind !== "wheel") {
    throw new Error(`candidate artifact ${index} has an invalid kind`);
  }
  const name = stringField(input, "name", `candidate artifact ${index}`);
  if (name !== basename(name) || name.length > 255) {
    throw new Error(`candidate artifact ${index} has an unsafe name`);
  }

  const expected =
    component === "openshell"
      ? {
          kind: "archive",
          name: "openshell-x86_64-unknown-linux-musl.tar.gz",
          path: `/NVIDIA/OpenShell/releases/download/v${resolvedCandidate}/`,
        }
      : component === "openclaw"
        ? {
            kind: "npm",
            name: `openclaw-${resolvedCandidate}.tgz`,
            path: "/openclaw/-/",
          }
        : component === "hermes" && index === 0
          ? {
              kind: "npm",
              name: `hermes-agent-${resolvedCandidate}.tgz`,
              path: "/hermes-agent/-/",
            }
          : { kind: "wheel", name: null, path: "/packages/" };
  if (kind !== expected.kind || (expected.name !== null && name !== expected.name)) {
    throw new Error(`candidate artifact ${index} does not match the resolved component`);
  }
  if (kind === "wheel" && !/^[0-9A-Za-z_.+-]+\.whl$/u.test(name)) {
    throw new Error(`candidate artifact ${index} has an invalid wheel name`);
  }
  return artifact(
    {
      digest: stringField(input, "digest", `candidate artifact ${index}`),
      digestAlgorithm,
      kind,
      name,
      url: stringField(input, "url", `candidate artifact ${index}`),
    },
    expected.path,
  );
}

/** Parse an uploaded resolver receipt and bind it to the trusted resolve-job output. */
export function parseCandidateReceipt(
  value: unknown,
  expectedResolutionId: string,
): CandidateReceipt {
  if (!/^[a-f0-9]{64}$/u.test(expectedResolutionId)) {
    throw new Error("expected candidate resolution id is invalid");
  }
  const input = record(value, "candidate receipt");
  if (input.schemaVersion !== 1) throw new Error("candidate receipt schema version must be 1");
  const component = stringField(input, "component", "candidate receipt");
  assertComponent(component);
  const requestedCandidate = stringField(input, "requestedCandidate", "candidate receipt");
  assertCandidate(component, requestedCandidate);
  const resolvedCandidate = stringField(input, "resolvedCandidate", "candidate receipt");
  if (!VERSION.test(resolvedCandidate)) {
    throw new Error("candidate receipt has an invalid resolved version");
  }
  if (
    (component === "openshell" && requestedCandidate.replace(/^v/u, "") !== resolvedCandidate) ||
    ((component === "openclaw" || component === "dcode") &&
      requestedCandidate !== resolvedCandidate)
  ) {
    throw new Error("candidate receipt resolved version does not match the request");
  }
  const nemoclawSha = stringField(input, "nemoclawSha", "candidate receipt");
  if (!FULL_SHA.test(nemoclawSha)) throw new Error("candidate receipt has an invalid NemoClaw SHA");
  if (!Array.isArray(input.artifacts))
    throw new Error("candidate receipt artifacts must be an array");
  const expectedArtifactCount = component === "hermes" ? 2 : 1;
  if (input.artifacts.length !== expectedArtifactCount) {
    throw new Error(`candidate receipt for ${component} has an invalid artifact count`);
  }
  const artifacts = input.artifacts.map((item, index) =>
    parseArtifact(item, component, resolvedCandidate, index),
  );
  const officialSource = stringField(input, "officialSource", "candidate receipt");
  const sourcePattern =
    component === "openshell"
      ? /^github:NVIDIA\/OpenShell:release:[1-9][0-9]*$/u
      : component === "openclaw"
        ? new RegExp(
            `^npm:openclaw@${resolvedCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "u",
          )
        : component === "hermes"
          ? /^github:NousResearch\/hermes-agent:release:[1-9][0-9]*$/u
          : new RegExp(
              `^pypi:deepagents-code==${resolvedCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              "u",
            );
  if (!sourcePattern.test(officialSource)) {
    throw new Error("candidate receipt has an invalid official source");
  }
  const resolvedCommitValue = input.resolvedCommit;
  const resolvedCommit =
    resolvedCommitValue === undefined
      ? undefined
      : stringField(input, "resolvedCommit", "candidate receipt");
  if (
    (component === "hermes" && (!resolvedCommit || !FULL_SHA.test(resolvedCommit))) ||
    (component !== "hermes" && resolvedCommit !== undefined)
  ) {
    throw new Error("candidate receipt has an invalid resolved commit");
  }
  const receiptWithoutId = {
    artifacts,
    component,
    nemoclawSha,
    officialSource,
    requestedCandidate,
    resolvedCandidate,
    ...(resolvedCommit ? { resolvedCommit } : {}),
    schemaVersion: 1 as const,
  };
  const resolutionId = sha256(stableJson(receiptWithoutId));
  if (
    stringField(input, "resolutionId", "candidate receipt") !== resolutionId ||
    resolutionId !== expectedResolutionId
  ) {
    throw new Error("candidate receipt does not match the trusted resolution id");
  }
  return { ...receiptWithoutId, resolutionId };
}

export function buildCandidatePlan(
  component: CandidateComponent,
  e2eSources: string,
): CandidatePlan {
  const selected = SELECTED_LANES[component];
  const live = LIVE_SELECTORS[component].map((entry) => {
    const marker = entry.selector === "job" ? `  ${entry.id}:\n` : `id: "${entry.id}"`;
    if (!e2eSources.includes(marker)) {
      throw new Error(`E2E source of truth does not declare ${entry.selector} ${entry.id}`);
    }
    return {
      ...entry,
      reason: "candidate injection is not yet wired into the credential-bearing E2E boundary",
      status: "skipped" as const,
    };
  });
  return {
    component,
    deterministic: ALL_LANES.map((id) => ({
      id,
      reason: selected.has(id)
        ? `the ${id} lane exercises ${component}-owned source or integration boundaries`
        : `the ${id} lane does not exercise an ${component}-owned boundary`,
      status: selected.has(id) ? "selected" : "skipped",
    })),
    live,
    schemaVersion: 1,
  };
}

export function verifyDigest(bytes: Uint8Array, artifactValue: Artifact): void {
  const actual = createHash(artifactValue.digestAlgorithm).update(bytes).digest("hex");
  if (actual !== artifactValue.digest) {
    throw new Error(`${artifactValue.name} ${artifactValue.digestAlgorithm} mismatch`);
  }
}

export function verifyObservedVersion(receipt: CandidateReceipt, output: string): string {
  const escaped = receipt.resolvedCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^0-9A-Za-z.])v?${escaped}([^0-9A-Za-z.]|$)`, "u").test(output.trim())) {
    throw new Error(
      `observed ${receipt.component} version does not match ${receipt.resolvedCandidate}: ${output.trim()}`,
    );
  }
  return receipt.resolvedCandidate;
}

export function finalizeEvidence(input: {
  attempt: string;
  plan: CandidatePlan;
  receipt: CandidateReceipt;
  results: LaneResult[];
  runId: string;
}): Record<string, unknown> {
  if (!/^[1-9][0-9]*$/u.test(input.runId) || !/^[1-9][0-9]*$/u.test(input.attempt)) {
    throw new Error("run id and attempt must be positive integers");
  }
  const selected = input.plan.deterministic
    .filter((lane) => lane.status === "selected")
    .map((lane) => lane.id)
    .sort();
  const actual = input.results.map((result) => result.lane).sort();
  if (new Set(actual).size !== actual.length || stableJson(actual) !== stableJson(selected)) {
    throw new Error(
      "lane results do not account for every selected deterministic lane exactly once",
    );
  }
  for (const result of input.results) {
    if (result.resolutionId !== input.receipt.resolutionId) {
      throw new Error(`lane ${result.lane} used a different candidate resolution`);
    }
    if (result.conclusion !== "success" && result.conclusion !== "failure") {
      throw new Error(`lane ${result.lane} has an invalid conclusion`);
    }
    if (
      result.conclusion === "success" &&
      (result.observedVersion !== input.receipt.resolvedCandidate || !result.observedOutput)
    ) {
      throw new Error(`lane ${result.lane} has no matching observed candidate version`);
    }
  }
  return {
    execution: { attempt: input.attempt, runId: input.runId },
    overall: input.results.every((result) => result.conclusion === "success")
      ? "success"
      : "failure",
    plan: input.plan,
    receipt: input.receipt,
    results: [...input.results].sort((left, right) => left.lane.localeCompare(right.lane)),
    schemaVersion: 1,
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function assertDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !DOWNLOAD_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096
  ) {
    throw new Error(`candidate download URL is not approved: ${raw}`);
  }
  return url;
}

async function fetchDownload(fetcher: FetchLike, rawUrl: string): Promise<Response> {
  let current = assertDownloadUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const response = await fetcher(current.href, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount === MAX_DOWNLOAD_REDIRECTS) {
      throw new Error("candidate download exceeded the redirect limit");
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("candidate download redirect has no location");
    current = assertDownloadUrl(new URL(location, current).href);
  }
  throw new Error("candidate download redirect handling failed");
}

export async function downloadCandidateArtifact(
  artifactValue: Artifact,
  directory: string,
  index: number,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const response = await fetchDownload(fetcher, artifactValue.url);
  if (!response.ok) throw new Error(`candidate download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyDigest(bytes, artifactValue);
  const extension =
    artifactValue.kind === "archive" ? ".tar.gz" : artifactValue.kind === "npm" ? ".tgz" : ".whl";
  const target = join(directory, `candidate-${index}${extension}`);
  await writeFile(target, bytes, { mode: 0o600 });
  return target;
}

export async function materializeCandidate(receipt: CandidateReceipt, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifactValue = receipt.artifacts[0];
  if (!artifactValue) throw new Error("candidate receipt has no artifact");
  const archives = await Promise.all(
    receipt.artifacts.map((candidateArtifact, index) =>
      downloadCandidateArtifact(candidateArtifact, directory, index),
    ),
  );
  const archive = archives[0]!;
  let binDirectory: string;
  let observedOutput: string;
  if (receipt.component === "openshell") {
    const extractDirectory = join(directory, "openshell");
    await mkdir(extractDirectory, { mode: 0o700 });
    run("tar", ["-xzf", archive, "-C", extractDirectory]);
    const binary = run("find", [
      extractDirectory,
      "-type",
      "f",
      "-name",
      "openshell",
      "-print",
      "-quit",
    ]);
    if (!binary) throw new Error("OpenShell archive has no openshell binary");
    await chmod(binary, 0o700);
    binDirectory = resolve(binary, "..");
    observedOutput = run(binary, ["--version"]);
  } else if (receipt.component === "dcode" || receipt.component === "hermes") {
    const venv = join(directory, "venv");
    run("python3", ["-m", "venv", venv]);
    const wheel =
      receipt.component === "dcode"
        ? archive
        : archives[receipt.artifacts.findIndex((item) => item.kind === "wheel")];
    if (!wheel) throw new Error(`${receipt.component} receipt has no verified wheel`);
    run(join(venv, "bin", "python"), ["-m", "pip", "install", "--no-deps", "--no-index", wheel]);
    binDirectory = join(venv, "bin");
    const packageName = receipt.component === "dcode" ? "deepagents-code" : "hermes-agent";
    observedOutput = run(join(venv, "bin", "python"), [
      "-c",
      `import importlib.metadata; print(importlib.metadata.version("${packageName}"))`,
    ]);
  } else {
    const prefix = join(directory, "npm");
    run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      archive,
    ]);
    binDirectory = join(prefix, "node_modules", ".bin");
    const executable = receipt.component === "openclaw" ? "openclaw" : "hermes";
    observedOutput = run(join(binDirectory, executable), ["--version"]);
  }
  const observedVersion = verifyObservedVersion(receipt, observedOutput);
  return {
    binDirectory,
    component: receipt.component,
    observedOutput,
    observedVersion,
    resolutionId: receipt.resolutionId,
    schemaVersion: 1 as const,
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument: ${key ?? ""}`);
    if (values.has(key)) throw new Error(`duplicate argument: ${key}`);
    values.set(key, value);
  }
  return values;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "resolve") {
    const receipt = await resolveCandidate({
      candidate: required(args, "--candidate"),
      component: required(args, "--component"),
      githubToken: process.env.GITHUB_TOKEN,
      nemoclawSha: required(args, "--nemoclaw-sha"),
    });
    await writeFile(required(args, "--output"), `${stableJson(receipt)}\n`, { mode: 0o600 });
    return;
  }
  if (command === "plan") {
    const component = required(args, "--component");
    assertComponent(component);
    const sources = await Promise.all([
      readFile(required(args, "--e2e-workflow"), "utf8"),
      readFile(required(args, "--e2e-registry"), "utf8"),
    ]);
    const plan = buildCandidatePlan(component, sources.join("\n"));
    await writeFile(required(args, "--output"), `${stableJson(plan)}\n`, { mode: 0o600 });
    return;
  }
  if (command === "materialize") {
    const receipt = parseCandidateReceipt(
      JSON.parse(await readFile(required(args, "--receipt"), "utf8")),
      required(args, "--resolution-id"),
    );
    const observed = await materializeCandidate(receipt, required(args, "--directory"));
    await writeFile(required(args, "--output"), `${stableJson(observed)}\n`, { mode: 0o600 });
    const githubEnv = args.get("--github-env");
    if (githubEnv) {
      await writeFile(
        githubEnv,
        [
          `PATH=${observed.binDirectory}:${process.env.PATH ?? ""}`,
          `NEMOCLAW_CANDIDATE_COMPONENT=${receipt.component}`,
          `NEMOCLAW_CANDIDATE_RECEIPT=${resolve(required(args, "--receipt"))}`,
          `NEMOCLAW_CANDIDATE_RESOLUTION_ID=${receipt.resolutionId}`,
          `NEMOCLAW_CANDIDATE_VERSION=${receipt.resolvedCandidate}`,
          "",
        ].join("\n"),
        { flag: "a" },
      );
    }
    return;
  }
  if (command === "finalize") {
    const receipt = JSON.parse(
      await readFile(required(args, "--receipt"), "utf8"),
    ) as CandidateReceipt;
    const plan = JSON.parse(await readFile(required(args, "--plan"), "utf8")) as CandidatePlan;
    const resultDirectory = required(args, "--results");
    const resultFiles = (await readdir(resultDirectory, { recursive: true })).filter((path) =>
      path.endsWith(".json"),
    );
    const results = await Promise.all(
      plan.deterministic
        .filter((lane) => lane.status === "selected")
        .map(async (lane) => {
          const matches = resultFiles.filter((path) => basename(path) === `${lane.id}.json`);
          if (matches.length !== 1) {
            throw new Error(`expected exactly one result file for lane ${lane.id}`);
          }
          return JSON.parse(await readFile(join(resultDirectory, matches[0]!), "utf8"));
        }),
    );
    const evidence = finalizeEvidence({
      attempt: required(args, "--attempt"),
      plan,
      receipt,
      results,
      runId: required(args, "--run-id"),
    });
    await writeFile(required(args, "--output"), `${stableJson(evidence)}\n`, { mode: 0o600 });
    return;
  }
  throw new Error("command must be resolve, plan, materialize, or finalize");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`candidate-compat: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
