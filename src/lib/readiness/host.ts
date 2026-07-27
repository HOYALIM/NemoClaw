// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Advisory, AdvisorySeverity } from "../advisories/types.js";
import { getVersion } from "../core/version.js";
import { assessHost, type HostAssessment, planHostAdvisories } from "../onboard/preflight.js";
import { redactFull } from "../security/redact.js";
import {
  type FindingSeverity,
  type ReadinessCapability,
  type ReadinessEvidence,
  type ReadinessObservation,
  type ReadinessProvenance,
  type ReadinessState,
  SYSTEM_READINESS_SCHEMA_VERSION,
  type SystemReadinessReport,
} from "./types.js";

const MAX_SUMMARY_LENGTH = 512;
const MAX_EVIDENCE_LENGTH = 1024;

const REQUIRED_CAPABILITY_IDS = new Set([
  "host.container-runtime",
  "host.runtime-resources",
  "host.node",
  "host.openshell",
]);

const ADVISORY_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  enable_docker_desktop_wsl_integration: ["host.container-runtime"],
  install_docker: ["host.container-runtime"],
  docker_group_permission: ["host.container-runtime"],
  start_docker: ["host.container-runtime"],
  container_runtime_under_provisioned: ["host.runtime-resources"],
  unsupported_runtime_warning: ["host.container-runtime"],
  install_nodejs: ["host.node"],
  install_openshell: ["host.openshell"],
  generate_nvidia_cdi_spec: ["host.nvidia-cdi"],
  refresh_nvidia_cdi_spec: ["host.nvidia-cdi"],
  install_nvidia_container_toolkit: ["host.nvidia-cdi"],
  warn_nvidia_cdi_refresh_unhealthy: ["host.nvidia-cdi"],
  wsl_docker_desktop_gpu_compatibility: ["host.nvidia-cdi"],
};

export interface HostReadinessProjectionOptions {
  nemoclawVersion: string;
  observedAt: string;
  sourceRevision?: string;
}

export interface CollectHostReadinessOptions {
  assessHostImpl?: () => HostAssessment;
  planHostAdvisoriesImpl?: (assessment: HostAssessment) => readonly Advisory[];
  getNemoclawVersionImpl?: () => string;
  nowImpl?: () => Date;
  sourceRevision?: string;
}

function booleanObservation(id: string, value: boolean): ReadinessObservation {
  return {
    id,
    state: value ? "present" : "absent",
    value,
  };
}

function optionalObservation(
  id: string,
  value: string | number | boolean | null | undefined,
): ReadinessObservation {
  if (value === undefined || value === null || value === "unknown") {
    return { id, state: "unknown" };
  }
  return { id, state: "present", value };
}

function capability(id: string, state: ReadinessState): ReadinessCapability {
  return { id, state };
}

function mapSeverity(severity: AdvisorySeverity): FindingSeverity {
  return severity === "hint" ? "info" : severity;
}

function advisoryEvidence(advisory: Advisory): ReadinessEvidence {
  const summary = redactFull(advisory.reason).slice(0, MAX_EVIDENCE_LENGTH);
  return {
    id: `advisory.${advisory.id}.detail`,
    summary: summary || "Advisory detail unavailable",
  };
}

function hostObservations(host: HostAssessment): ReadinessObservation[] {
  const cdiSpecState: ReadinessState = !host.hasNvidiaGpu
    ? "unknown"
    : host.cdiNvidiaGpuSpecMissing
      ? "absent"
      : "present";
  const cdiHealthState: ReadinessState =
    !host.hasNvidiaGpu || host.cdiNvidiaGpuSpecMissing
      ? "unknown"
      : host.cdiNvidiaGpuSpecNeedsRepair || host.cdiNvidiaGpuRefreshUnhealthy
        ? "absent"
        : "present";

  return [
    optionalObservation("host.platform", host.platform),
    booleanObservation("host.wsl", host.isWsl),
    booleanObservation("host.headless", host.isHeadlessLikely),
    optionalObservation("runtime.kind", host.runtime),
    booleanObservation("runtime.docker-cli", host.dockerInstalled),
    booleanObservation("runtime.docker-daemon", host.dockerReachable),
    optionalObservation("runtime.cgroup-version", host.dockerCgroupVersion),
    optionalObservation("runtime.storage-driver", host.dockerStorageDriver),
    optionalObservation("runtime.cpu-limit", host.dockerCpus),
    optionalObservation("runtime.memory-limit-bytes", host.dockerMemTotalBytes),
    booleanObservation("tool.node", host.nodeInstalled),
    booleanObservation("tool.openshell", host.openshellInstalled),
    booleanObservation("gpu.nvidia", host.hasNvidiaGpu),
    booleanObservation("gpu.container-toolkit", host.nvidiaContainerToolkitInstalled),
    { id: "gpu.cdi-spec", state: cdiSpecState },
    { id: "gpu.cdi-health", state: cdiHealthState },
  ];
}

function hostCapabilities(host: HostAssessment): ReadinessCapability[] {
  const containerRuntimeState: ReadinessState =
    !host.dockerInstalled || !host.dockerReachable || host.isUnsupportedRuntime
      ? "absent"
      : host.runtime === "unknown"
        ? "unknown"
        : "present";
  const runtimeResourcesState: ReadinessState = !host.dockerReachable
    ? "absent"
    : host.isContainerRuntimeUnderProvisioned
      ? "absent"
      : host.dockerCpus === undefined || host.dockerMemTotalBytes === undefined
        ? "unknown"
        : "present";
  const nvidiaCdiState: ReadinessState = !host.hasNvidiaGpu
    ? "unknown"
    : !host.nvidiaContainerToolkitInstalled ||
        host.cdiNvidiaGpuSpecMissing ||
        host.cdiNvidiaGpuSpecNeedsRepair ||
        host.cdiNvidiaGpuRefreshUnhealthy
      ? "absent"
      : "present";

  return [
    capability("host.container-runtime", containerRuntimeState),
    capability("host.runtime-resources", runtimeResourcesState),
    capability("host.node", host.nodeInstalled ? "present" : "absent"),
    capability("host.openshell", host.openshellInstalled ? "present" : "absent"),
    capability("host.nvidia-gpu", host.hasNvidiaGpu ? "present" : "absent"),
    capability("host.nvidia-cdi", nvidiaCdiState),
  ];
}

function provenance(options: HostReadinessProjectionOptions): ReadinessProvenance {
  return {
    nemoclawVersion: options.nemoclawVersion,
    observedAt: options.observedAt,
    ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
  };
}

function projectOutcome(
  advisories: readonly Advisory[],
  capabilities: readonly ReadinessCapability[],
):
  | { status: "supported"; exitCode: 0 }
  | { status: "incompatible"; exitCode: 2 }
  | { status: "inconclusive"; exitCode: 3 } {
  if (
    advisories.some((advisory) => advisory.severity === "fatal" || advisory.severity === "blocking")
  ) {
    return { status: "incompatible", exitCode: 2 };
  }
  if (
    capabilities.some((entry) => REQUIRED_CAPABILITY_IDS.has(entry.id) && entry.state === "absent")
  ) {
    return { status: "incompatible", exitCode: 2 };
  }
  if (
    capabilities.some((entry) => REQUIRED_CAPABILITY_IDS.has(entry.id) && entry.state === "unknown")
  ) {
    return { status: "inconclusive", exitCode: 3 };
  }
  return { status: "supported", exitCode: 0 };
}

export function projectHostAssessmentToSystemReadiness(
  host: HostAssessment,
  advisories: readonly Advisory[],
  options: HostReadinessProjectionOptions,
): SystemReadinessReport {
  const observations = hostObservations(host);
  const capabilities = hostCapabilities(host);
  const evidence = advisories.map(advisoryEvidence);
  const findings = advisories.map((advisory) => ({
    id: `advisory.${advisory.id}`,
    severity: mapSeverity(advisory.severity),
    summary: advisory.title.slice(0, MAX_SUMMARY_LENGTH) || "Host readiness advisory",
    ...(ADVISORY_CAPABILITIES[advisory.id]
      ? { capabilityIds: ADVISORY_CAPABILITIES[advisory.id] }
      : {}),
    evidenceIds: [`advisory.${advisory.id}.detail`],
  }));

  return {
    schemaVersion: SYSTEM_READINESS_SCHEMA_VERSION,
    ...projectOutcome(advisories, capabilities),
    mutated: false,
    provenance: provenance(options),
    observations,
    capabilities,
    qualifications: [],
    findings,
    evidence,
  };
}

function observationFailureReport(
  error: unknown,
  options: HostReadinessProjectionOptions,
): SystemReadinessReport {
  const detail = redactFull(error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_EVIDENCE_LENGTH,
  );
  return {
    schemaVersion: SYSTEM_READINESS_SCHEMA_VERSION,
    status: "inconclusive",
    exitCode: 3,
    mutated: false,
    provenance: provenance(options),
    observations: [
      {
        id: "host.observation",
        state: "unknown",
        evidenceIds: ["host.observation-failure"],
      },
    ],
    capabilities: [
      capability("host.container-runtime", "unknown"),
      capability("host.runtime-resources", "unknown"),
      capability("host.node", "unknown"),
      capability("host.openshell", "unknown"),
      capability("host.nvidia-gpu", "unknown"),
      capability("host.nvidia-cdi", "unknown"),
    ],
    qualifications: [],
    findings: [
      {
        id: "host.observation-failed",
        severity: "fatal",
        summary: "Host observation failed",
        evidenceIds: ["host.observation-failure"],
      },
    ],
    evidence: [
      {
        id: "host.observation-failure",
        summary: detail || "Host observation failed without diagnostic details",
      },
    ],
  };
}

export function collectHostSystemReadiness(
  options: CollectHostReadinessOptions = {},
): SystemReadinessReport {
  const observedAt = (options.nowImpl ?? (() => new Date()))().toISOString();
  let nemoclawVersion = "unknown";

  try {
    nemoclawVersion = (options.getNemoclawVersionImpl ?? getVersion)();
    const projectionOptions: HostReadinessProjectionOptions = {
      nemoclawVersion,
      observedAt,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    };
    const host = (options.assessHostImpl ?? assessHost)();
    const advisories = (options.planHostAdvisoriesImpl ?? planHostAdvisories)(host);
    return projectHostAssessmentToSystemReadiness(host, advisories, projectionOptions);
  } catch (error) {
    return observationFailureReport(error, {
      nemoclawVersion,
      observedAt,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    });
  }
}
