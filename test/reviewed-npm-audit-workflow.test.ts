// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml } from "./helpers/e2e-workflow-contract";

type WorkflowStep = {
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
};

type WorkflowJob = {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Record<string, WorkflowJob>;
};

const REPO_ROOT = path.join(import.meta.dirname, "..");
const BOOTSTRAP_SHA = "57c97bf5dc0bf2489ec494d4637977be3986afb8";
// Removal condition: delete the PR-6830 fork bootstrap after this PR merges and
// the base branch contains the schema-v2 reviewed npm audit action.
const BOOTSTRAP_IF =
  "${{ steps.trusted-reviewed-npm-audit.outputs.available != 'true' && github.event.pull_request.number == 6830 && github.event.pull_request.head.repo.full_name == 'HOYALIM/NemoClaw' }}";
const REJECT_UNAVAILABLE_IF =
  "${{ steps.trusted-reviewed-npm-audit.outputs.available != 'true' && (github.event.pull_request.number != 6830 || github.event.pull_request.head.repo.full_name != 'HOYALIM/NemoClaw') }}";

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe("trusted reviewed npm audit workflow (#5896)", () => {
  // source-shape-contract: security -- PR dependency audit code must come from the base SHA or the one-time signed bootstrap
  it("runs PR audits from trusted code and keeps the main audit on the checked-in action", () => {
    const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
    const main = readYaml<Workflow>(".github/workflows/main.yaml");
    const prJob = pr.jobs["reviewed-npm-audit"];
    const mainJob = main.jobs["reviewed-npm-audit"];

    const trustedCheckout = requiredStep(prJob, "Checkout trusted reviewed npm audit");
    expect(trustedCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-reviewed-npm-audit",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    const sparseCheckout = String(trustedCheckout.with?.["sparse-checkout"]);
    expect(sparseCheckout).toContain(".github/actions/ci-reviewed-npm-audit");
    expect(sparseCheckout).toContain("ci/reviewed-npm-audit.json");
    expect(sparseCheckout).toContain("scripts/audit-reviewed-npm-graph.mts");
    expect(sparseCheckout).toContain("scripts/lib/reviewed-npm-archive.mts");

    const detection = requiredStep(prJob, "Detect trusted reviewed npm audit schema");
    expect(detection.id).toBe("trusted-reviewed-npm-audit");
    expect(detection.run).toContain("resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT)");
    expect(detection.run).toContain(".trusted-reviewed-npm-audit/ci/reviewed-npm-audit.json");

    const bootstrap = requiredStep(prJob, "Checkout pinned bootstrap reviewed npm audit");
    expect(bootstrap.if).toBe(BOOTSTRAP_IF);
    expect(bootstrap.with).toMatchObject({
      repository: "HOYALIM/NemoClaw",
      ref: BOOTSTRAP_SHA,
      path: ".trusted-reviewed-npm-audit-bootstrap",
      "persist-credentials": false,
    });
    const rejectUnavailable = requiredStep(prJob, "Reject unavailable trusted reviewed npm audit");
    expect(rejectUnavailable.if).toBe(REJECT_UNAVAILABLE_IF);
    expect(rejectUnavailable.run).toContain("exit 1");
    expect(requiredStep(prJob, "Audit reviewed production npm graphs")).toMatchObject({
      if: "${{ steps.trusted-reviewed-npm-audit.outputs.available == 'true' }}",
      uses: "./.trusted-reviewed-npm-audit/.github/actions/ci-reviewed-npm-audit",
      with: {
        "target-root": "${{ github.workspace }}",
        "report-dir": "artifacts/reviewed-npm-audit",
      },
    });
    expect(
      requiredStep(prJob, "Audit reviewed production npm graphs (pinned bootstrap)"),
    ).toMatchObject({
      if: BOOTSTRAP_IF,
      uses: "./.trusted-reviewed-npm-audit-bootstrap/.github/actions/ci-reviewed-npm-audit",
    });
    expect(requiredStep(mainJob, "Audit reviewed production npm graphs")).toMatchObject({
      uses: "./.github/actions/ci-reviewed-npm-audit",
      with: {
        "target-root": "${{ github.workspace }}",
        "report-dir": "artifacts/reviewed-npm-audit",
      },
    });
  });

  // source-shape-contract: security -- The trusted composite action must execute only its bundled driver while treating the PR checkout as explicit data
  it("executes the trusted driver and helper against explicit target inputs", () => {
    const action = fs.readFileSync(
      path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit", "action.yaml"),
      "utf8",
    );
    const driver = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "audit-reviewed-npm-graph.mts"),
      "utf8",
    );

    expect(action).toContain('node-version: "22.22.2"');
    expect(action).toContain("npm install --global npm@10.9.4");
    expect(action).toContain("NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT");
    expect(action).toContain("NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR");
    expect(action).toContain(
      'node --experimental-strip-types "$GITHUB_ACTION_PATH/../../../scripts/audit-reviewed-npm-graph.mts"',
    );
    expect(action).not.toContain("run: node --experimental-strip-types scripts/");
    expect(driver).toContain("resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT)");
    expect(driver).not.toContain('resolveTargetPath(\n  "ci/reviewed-npm-audit.json"');
  });
});
