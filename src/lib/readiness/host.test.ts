// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with {
  type: "json",
};
import type { Advisory } from "../advisories/types.js";
import type { HostAssessment } from "../onboard/preflight.js";
import { collectHostSystemReadiness, projectHostAssessmentToSystemReadiness } from "./host.js";
import { getSystemReadinessReferenceErrors } from "./references.js";

const projectionOptions = {
  nemoclawVersion: "0.0.97",
  sourceRevision: "962b2834a0000000000000000000000000000000",
  observedAt: "2026-07-27T20:00:00.000Z",
};

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker",
    packageManager: "apt",
    systemctlAvailable: true,
    dockerServiceActive: true,
    dockerServiceEnabled: true,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerCgroupVersion: "v2",
    dockerDefaultCgroupnsMode: "private",
    dockerStorageDriver: "overlay2",
    dockerUsesContainerdSnapshotter: false,
    dockerCpus: 8,
    dockerMemTotalBytes: 32 * 1024 ** 3,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: true,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    cdiNvidiaGpuSpecNeedsRepair: false,
    cdiNvidiaGpuRefreshUnhealthy: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
    ...overrides,
  };
}

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: "install_docker",
    severity: "blocking",
    phase: "preflight.host",
    title: "Install Docker",
    reason: "Docker is required before onboarding.",
    resumeSafe: false,
    ...overrides,
  };
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", { type: "string", validate: () => true });
  return ajv.compile(systemReadinessSchema as AnySchema);
}

describe("host system readiness projection", () => {
  it("projects supported host observations without exposing HostAssessment", () => {
    const report = projectHostAssessmentToSystemReadiness(host(), [], projectionOptions);

    expect(report).toMatchObject({
      status: "supported",
      exitCode: 0,
      mutated: false,
      provenance: projectionOptions,
      qualifications: [],
      findings: [],
      evidence: [],
    });
    expect(report.observations).toContainEqual({
      id: "runtime.docker-daemon",
      state: "present",
      value: true,
    });
    expect(report.capabilities).toContainEqual({
      id: "host.nvidia-cdi",
      state: "unknown",
    });
    expect(getSystemReadinessReferenceErrors(report)).toEqual([]);

    const validate = createValidator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("projects current blocking advisories as incompatible stable findings", () => {
    const report = projectHostAssessmentToSystemReadiness(
      host({
        runtime: "unknown",
        dockerInstalled: false,
        dockerRunning: false,
        dockerReachable: false,
        dockerCgroupVersion: "unknown",
        dockerStorageDriver: undefined,
        dockerCpus: undefined,
        dockerMemTotalBytes: undefined,
      }),
      [advisory()],
      projectionOptions,
    );

    expect(report).toMatchObject({ status: "incompatible", exitCode: 2 });
    expect(report.findings).toContainEqual({
      id: "advisory.install_docker",
      severity: "blocking",
      summary: "Install Docker",
      capabilityIds: ["host.container-runtime"],
      evidenceIds: ["advisory.install_docker.detail"],
    });
    expect(report.evidence).toContainEqual({
      id: "advisory.install_docker.detail",
      summary: "Docker is required before onboarding.",
    });
    expect(getSystemReadinessReferenceErrors(report)).toEqual([]);
  });

  it("fails closed when a required capability is absent without an advisory", () => {
    const report = projectHostAssessmentToSystemReadiness(
      host({ nodeInstalled: false }),
      [],
      projectionOptions,
    );

    expect(report).toMatchObject({ status: "incompatible", exitCode: 2 });
    expect(report.capabilities).toContainEqual({
      id: "host.node",
      state: "absent",
    });
  });

  it.each([
    {
      label: "unreachable daemon",
      overrides: { dockerReachable: false, dockerRunning: false },
      advisory: advisory({ id: "start_docker" }),
      capability: "host.container-runtime",
    },
    {
      label: "under-provisioned runtime",
      overrides: { isContainerRuntimeUnderProvisioned: true },
      advisory: advisory({
        id: "container_runtime_under_provisioned",
        severity: "warning",
      }),
      capability: "host.runtime-resources",
    },
    {
      label: "unsupported runtime",
      overrides: { runtime: "podman" as const, isUnsupportedRuntime: true },
      advisory: advisory({ id: "unsupported_runtime_warning", severity: "warning" }),
      capability: "host.container-runtime",
    },
    {
      label: "missing NVIDIA toolkit",
      overrides: {
        hasNvidiaGpu: true,
        cdiNvidiaGpuSpecMissing: true,
        cdiNvidiaGpuSpecNeedsRepair: true,
      },
      advisory: advisory({ id: "install_nvidia_container_toolkit" }),
      capability: "host.nvidia-cdi",
    },
    {
      label: "missing NVIDIA CDI spec",
      overrides: {
        hasNvidiaGpu: true,
        nvidiaContainerToolkitInstalled: true,
        cdiNvidiaGpuSpecMissing: true,
        cdiNvidiaGpuSpecNeedsRepair: true,
      },
      advisory: advisory({ id: "generate_nvidia_cdi_spec" }),
      capability: "host.nvidia-cdi",
    },
    {
      label: "stale NVIDIA CDI spec",
      overrides: {
        hasNvidiaGpu: true,
        nvidiaContainerToolkitInstalled: true,
        cdiNvidiaGpuSpecNeedsRepair: true,
      },
      advisory: advisory({ id: "refresh_nvidia_cdi_spec" }),
      capability: "host.nvidia-cdi",
    },
  ])("projects a stable capability and finding for $label", ({
    overrides,
    advisory,
    capability,
  }) => {
    const report = projectHostAssessmentToSystemReadiness(
      host(overrides),
      [advisory],
      projectionOptions,
    );

    expect(report.capabilities).toContainEqual({ id: capability, state: "absent" });
    expect(report.findings[0]).toMatchObject({
      id: `advisory.${advisory.id}`,
      capabilityIds: [capability],
    });
    expect(getSystemReadinessReferenceErrors(report)).toEqual([]);
  });

  it("keeps unknown observations distinct from confirmed absence", () => {
    const report = projectHostAssessmentToSystemReadiness(
      host({
        runtime: "unknown",
        dockerCpus: undefined,
        dockerMemTotalBytes: undefined,
      }),
      [],
      projectionOptions,
    );

    expect(report).toMatchObject({ status: "inconclusive", exitCode: 3 });
    expect(report.observations).toContainEqual({
      id: "runtime.kind",
      state: "unknown",
    });
    expect(report.capabilities).toContainEqual({
      id: "host.container-runtime",
      state: "unknown",
    });
    expect(report.capabilities).toContainEqual({
      id: "host.runtime-resources",
      state: "unknown",
    });
  });

  it("redacts and bounds advisory evidence", () => {
    const secret = "nvapi-abcdefghijklmnopqrstuvwxyz123456789";
    const report = projectHostAssessmentToSystemReadiness(
      host(),
      [
        advisory({
          severity: "warning",
          reason: `probe returned ${secret}${"x".repeat(2_000)}`,
        }),
      ],
      projectionOptions,
    );
    const summary = report.evidence[0]?.summary ?? "";

    expect(summary).not.toContain(secret);
    expect(summary.length).toBeLessThanOrEqual(1024);
  });

  it("fails closed as unknown when host observation throws", () => {
    const secret = "nvapi-abcdefghijklmnopqrstuvwxyz123456789";
    const report = collectHostSystemReadiness({
      assessHostImpl: () => {
        throw new Error(`probe failed with ${secret}`);
      },
      getNemoclawVersionImpl: () => "0.0.97",
      nowImpl: () => new Date("2026-07-27T20:00:00Z"),
    });

    expect(report).toMatchObject({ status: "inconclusive", exitCode: 3 });
    expect(report.observations).toEqual([
      {
        id: "host.observation",
        state: "unknown",
        evidenceIds: ["host.observation-failure"],
      },
    ]);
    expect(report.evidence[0]?.summary).not.toContain(secret);
    expect(getSystemReadinessReferenceErrors(report)).toEqual([]);

    const validate = createValidator();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("fails closed when build provenance cannot be resolved", () => {
    const report = collectHostSystemReadiness({
      getNemoclawVersionImpl: () => {
        throw new Error("version unavailable");
      },
      nowImpl: () => new Date("2026-07-27T20:00:00Z"),
    });

    expect(report).toMatchObject({
      status: "inconclusive",
      exitCode: 3,
      provenance: {
        nemoclawVersion: "unknown",
        observedAt: "2026-07-27T20:00:00.000Z",
      },
    });
  });

  it("collects a fresh assessment for every report", () => {
    const assessHostImpl = vi
      .fn<() => HostAssessment>()
      .mockReturnValueOnce(host({ isWsl: false }))
      .mockReturnValueOnce(host({ isWsl: true }));
    const options = {
      assessHostImpl,
      planHostAdvisoriesImpl: () => [],
      getNemoclawVersionImpl: () => "0.0.97",
      nowImpl: () => new Date("2026-07-27T20:00:00Z"),
    };

    const first = collectHostSystemReadiness(options);
    const second = collectHostSystemReadiness(options);

    expect(assessHostImpl).toHaveBeenCalledTimes(2);
    expect(first.observations).toContainEqual({
      id: "host.wsl",
      state: "absent",
      value: false,
    });
    expect(second.observations).toContainEqual({
      id: "host.wsl",
      state: "present",
      value: true,
    });
  });
});
