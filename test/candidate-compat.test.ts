// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildCandidatePlan,
  downloadCandidateArtifact,
  finalizeEvidence,
  parseCandidateReceipt,
  resolveCandidate,
  verifyDigest,
  verifyObservedVersion,
} from "../tools/candidate-compat.mts";

const SHA = "a".repeat(40);
const E2E_SOURCES = [".github/workflows/e2e.yaml", "test/e2e/registry/definitions/baseline.ts"]
  .map((path) => readFileSync(resolve(path), "utf8"))
  .join("\n");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("candidate compatibility contract", () => {
  // source-shape-contract: security -- This pins the trusted controller and read-only workflow boundary around candidate code execution.
  it("keeps the manual controller read-only and separate from candidate source (#6691)", () => {
    const source = readFileSync(resolve(".github/workflows/candidate-compatibility.yaml"), "utf8");
    const workflow = parseYaml(source) as {
      jobs: Record<string, unknown>;
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: Record<string, string>;
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual([
      "candidate",
      "component",
      "nemoclaw_ref",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual(["deterministic", "evidence", "resolve"]);
    expect(source).toContain("candidate compatibility must be dispatched from main");
    expect(source).toContain("path: controller");
    expect(source).toContain("path: candidate-source");
    expect(source).toContain("git -C candidate-source rev-parse --verify HEAD^{commit}");
    const toolSource = readFileSync(resolve("tools/candidate-compat.mts"), "utf8");
    expect(toolSource).toContain("NEMOCLAW_CANDIDATE_RECEIPT");
    expect(source).toContain('--resolution-id "${{ needs.resolve.outputs.resolution_id }}"');
    expect(source).not.toMatch(/\b(?:git push|gh pr|npm publish|docker push)\b/u);
  });

  it("rejects ambiguous and unsafe candidate input before metadata access (#6691)", async () => {
    const fetcher = async () => {
      throw new Error("metadata must not be fetched");
    };
    await expect(
      resolveCandidate({ candidate: "latest", component: "openclaw", fetcher, nemoclawSha: SHA }),
    ).rejects.toThrow("exact version");
    await expect(
      resolveCandidate({
        candidate: "v1.2.3\nINJECTED=1",
        component: "openshell",
        fetcher,
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("unsafe characters");
    await expect(
      resolveCandidate({
        candidate: "1.2.3",
        component: "unknown",
        fetcher,
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("component must be one of");
  });

  it("binds OpenShell evidence to an official release asset digest (#6691)", async () => {
    const fetcher = async () =>
      response({
        assets: [
          {
            browser_download_url:
              "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.82/openshell-x86_64-unknown-linux-musl.tar.gz",
            digest: `sha256:${"b".repeat(64)}`,
            name: "openshell-x86_64-unknown-linux-musl.tar.gz",
          },
        ],
        draft: false,
        id: 82,
        tag_name: "v0.0.82",
      });
    const first = await resolveCandidate({
      candidate: "v0.0.82",
      component: "openshell",
      fetcher,
      nemoclawSha: SHA,
    });
    const rerun = await resolveCandidate({
      candidate: "v0.0.82",
      component: "openshell",
      fetcher,
      nemoclawSha: SHA,
    });
    expect(first).toEqual(rerun);
    expect(first).toMatchObject({
      nemoclawSha: SHA,
      officialSource: "github:NVIDIA/OpenShell:release:82",
      requestedCandidate: "v0.0.82",
      resolvedCandidate: "0.0.82",
    });
    expect(first.artifacts[0]?.digest).toBe("b".repeat(64));
    expect(first.resolutionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseCandidateReceipt(first, first.resolutionId)).toEqual(first);
    expect(() =>
      parseCandidateReceipt(
        {
          ...first,
          artifacts: [
            {
              ...first.artifacts[0],
              url: "https://example.com/openshell-x86_64-unknown-linux-musl.tar.gz",
            },
          ],
        },
        first.resolutionId,
      ),
    ).toThrow("approved official HTTPS host");
    expect(() =>
      parseCandidateReceipt({ ...first, resolutionId: "f".repeat(64) }, first.resolutionId),
    ).toThrow("trusted resolution id");
  });

  it("fails closed on missing upstream provenance and metadata errors (#6691)", async () => {
    await expect(
      resolveCandidate({
        candidate: "0.0.82",
        component: "openshell",
        fetcher: async () => response({ assets: [], draft: false, id: 82, tag_name: "v0.0.82" }),
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("missing openshell-x86_64");
    await expect(
      resolveCandidate({
        candidate: "2026.7.1",
        component: "openclaw",
        fetcher: async () => response({ message: "unavailable" }, 503),
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("official metadata request failed (503)");
  });

  it("rejects unofficial npm tarballs even with valid integrity (#6691)", async () => {
    const integrity = createHash("sha512").update("archive").digest("base64");
    await expect(
      resolveCandidate({
        candidate: "2026.7.1",
        component: "openclaw",
        fetcher: async () =>
          response({
            dist: {
              integrity: `sha512-${integrity}`,
              tarball: "https://example.com/openclaw-2026.7.1.tgz",
            },
            version: "2026.7.1",
          }),
        nemoclawSha: SHA,
      }),
    ).rejects.toThrow("approved official HTTPS host");
  });

  it("peels Hermes tags and resolves exact Hermes and DCode wheels (#6691)", async () => {
    const integrity = createHash("sha512").update("hermes-npm").digest("base64");
    const commit = "c".repeat(40);
    const responses = new Map<string, Response>([
      [
        "https://api.github.com/repos/NousResearch/hermes-agent/releases/tags/v2026.7.1",
        response({ draft: false, id: 701, tag_name: "v2026.7.1" }),
      ],
      [
        "https://api.github.com/repos/NousResearch/hermes-agent/git/ref/tags/v2026.7.1",
        response({
          object: {
            sha: "d".repeat(40),
            type: "tag",
            url: "https://api.github.com/repos/NousResearch/hermes-agent/git/tags/annotated",
          },
        }),
      ],
      [
        "https://api.github.com/repos/NousResearch/hermes-agent/git/tags/annotated",
        response({ object: { sha: commit, type: "commit" } }),
      ],
      [
        `https://raw.githubusercontent.com/NousResearch/hermes-agent/${commit}/pyproject.toml`,
        new Response('[project]\nversion = "0.18.0"\n'),
      ],
      [
        "https://registry.npmjs.org/hermes-agent/0.18.0",
        response({
          dist: {
            integrity: `sha512-${integrity}`,
            tarball: "https://registry.npmjs.org/hermes-agent/-/hermes-agent-0.18.0.tgz",
          },
          version: "0.18.0",
        }),
      ],
      [
        "https://pypi.org/pypi/hermes-agent/0.18.0/json",
        response({
          info: { name: "hermes-agent", version: "0.18.0" },
          urls: [
            {
              digests: { sha256: "e".repeat(64) },
              filename: "hermes_agent-0.18.0-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: "https://files.pythonhosted.org/packages/hermes_agent-0.18.0.whl",
              yanked: false,
            },
          ],
        }),
      ],
      [
        "https://pypi.org/pypi/deepagents-code/0.1.34/json",
        response({
          info: { name: "deepagents-code", version: "0.1.34" },
          urls: [
            {
              digests: { sha256: "f".repeat(64) },
              filename: "deepagents_code-0.1.34-py3-none-any.whl",
              packagetype: "bdist_wheel",
              url: "https://files.pythonhosted.org/packages/deepagents_code-0.1.34.whl",
              yanked: false,
            },
          ],
        }),
      ],
    ]);
    const fetcher = async (url: string) =>
      responses.get(url) ?? response({ message: "unexpected URL" }, 404);
    const hermes = await resolveCandidate({
      candidate: "v2026.7.1",
      component: "hermes",
      fetcher,
      nemoclawSha: SHA,
    });
    expect(hermes).toMatchObject({ resolvedCandidate: "0.18.0", resolvedCommit: commit });
    expect(hermes.artifacts.map((item) => item.kind)).toEqual(["npm", "wheel"]);
    const dcode = await resolveCandidate({
      candidate: "0.1.34",
      component: "dcode",
      fetcher,
      nemoclawSha: SHA,
    });
    expect(dcode).toMatchObject({
      officialSource: "pypi:deepagents-code==0.1.34",
      resolvedCandidate: "0.1.34",
    });
  });

  it("detects digest and observed runtime version mismatches (#6691)", () => {
    const bytes = new TextEncoder().encode("candidate");
    expect(() =>
      verifyDigest(bytes, {
        digest: "0".repeat(64),
        digestAlgorithm: "sha256",
        kind: "archive",
        name: "candidate.tgz",
        url: "https://registry.npmjs.org/openclaw/-/candidate.tgz",
      }),
    ).toThrow("sha256 mismatch");
    expect(() =>
      verifyObservedVersion(
        {
          artifacts: [],
          component: "openclaw",
          nemoclawSha: SHA,
          officialSource: "npm:openclaw@2026.7.1",
          requestedCandidate: "2026.7.1",
          resolutionId: "c".repeat(64),
          resolvedCandidate: "2026.7.1",
          schemaVersion: 1,
        },
        "openclaw 2026.7.2",
      ),
    ).toThrow("does not match 2026.7.1");
  });

  it("validates every redirect before writing a digest-bound artifact (#6691)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-download-"));
    const body = "candidate archive";
    const candidateArtifact = {
      digest: createHash("sha256").update(body).digest("hex"),
      digestAlgorithm: "sha256" as const,
      kind: "npm" as const,
      name: "openclaw-2026.7.1.tgz",
      url: "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz",
    };
    try {
      const requests: string[] = [];
      await expect(
        downloadCandidateArtifact(candidateArtifact, directory, 0, async (url, init) => {
          requests.push(url);
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            headers: { location: "http://127.0.0.1/internal" },
            status: 302,
          });
        }),
      ).rejects.toThrow("not approved");
      expect(requests).toEqual([candidateArtifact.url]);

      const target = await downloadCandidateArtifact(
        candidateArtifact,
        directory,
        0,
        async () => new Response(body),
      );
      expect(basename(target)).toBe("candidate-0.tgz");
      expect(readFileSync(target, "utf8")).toBe(body);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("records every deterministic lane and validates live selectors against E2E (#6691)", () => {
    const plan = buildCandidatePlan("openshell", E2E_SOURCES);
    expect(plan.deterministic).toHaveLength(6);
    expect(
      plan.deterministic.filter((lane) => lane.status === "selected").map((lane) => lane.id),
    ).toEqual(["source-unit", "integration", "installer", "e2e-support"]);
    expect(plan.deterministic.filter((lane) => lane.status === "skipped")).toEqual([
      expect.objectContaining({ id: "package-contract", reason: expect.any(String) }),
      expect.objectContaining({ id: "plugin", reason: expect.any(String) }),
    ]);
    expect(plan.live).toEqual([
      expect.objectContaining({ id: "full-e2e", selector: "job", status: "skipped" }),
      expect.objectContaining({
        id: "openshell-gateway-auth-contract",
        selector: "job",
        status: "skipped",
      }),
    ]);
    expect(() => buildCandidatePlan("openshell", E2E_SOURCES.replace("  full-e2e:\n", ""))).toThrow(
      "does not declare job full-e2e",
    );
    expect(buildCandidatePlan("dcode", E2E_SOURCES).live).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-cloud-langchain-deepagents-code",
        selector: "target",
        status: "skipped",
      }),
    ]);
  });

  it("finalizes only complete results from the same candidate resolution (#6691)", () => {
    const plan = buildCandidatePlan("hermes", E2E_SOURCES);
    const receipt = {
      artifacts: [],
      component: "hermes" as const,
      nemoclawSha: SHA,
      officialSource: "github:NousResearch/hermes-agent:release:1",
      requestedCandidate: "v2026.7.1",
      resolutionId: "d".repeat(64),
      resolvedCandidate: "0.18.0",
      resolvedCommit: "e".repeat(40),
      schemaVersion: 1 as const,
    };
    const results = ["source-unit", "integration", "e2e-support"].map((lane) => ({
      conclusion: "success" as const,
      lane: lane as "source-unit" | "integration" | "e2e-support",
      observedOutput: "hermes 0.18.0",
      observedVersion: "0.18.0",
      resolutionId: receipt.resolutionId,
    }));
    const evidence = finalizeEvidence({ attempt: "2", plan, receipt, results, runId: "123" });
    expect(evidence).toMatchObject({
      execution: { attempt: "2", runId: "123" },
      overall: "success",
      schemaVersion: 1,
    });
    expect(() =>
      finalizeEvidence({ attempt: "2", plan, receipt, results: results.slice(1), runId: "123" }),
    ).toThrow("account for every selected deterministic lane exactly once");
    expect(() =>
      finalizeEvidence({
        attempt: "2",
        plan,
        receipt,
        results: [{ ...results[0]!, resolutionId: "f".repeat(64) }, ...results.slice(1)],
        runId: "123",
      }),
    ).toThrow("used a different candidate resolution");
    expect(() =>
      finalizeEvidence({
        attempt: "2",
        plan,
        receipt,
        results: [{ ...results[0]!, observedVersion: "0.17.0" }, ...results.slice(1)],
        runId: "123",
      }),
    ).toThrow("has no matching observed candidate version");
  });
});
