// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunCaptureExFn } from "../../../inference/local";
import { getOllamaProbeCommand, getResolvedOllamaHost } from "../../../inference/local";
import {
  type OllamaRuntimeModelStatus,
  type OllamaRuntimeRunCaptureFn,
  probeOllamaRuntimeModelStatus,
} from "../../../inference/ollama-runtime-context";

const { runCaptureEx } = require("../../../runner") as typeof import("../../../runner");

export interface OllamaRestartRecoveryRoute {
  provider?: string | null;
  model?: string | null;
}

export interface OllamaRestartRecoveryDeps {
  probeRuntimeModelStatus?: (
    model: string,
    getOllamaHost: () => string,
    runCaptureImpl?: OllamaRuntimeRunCaptureFn,
  ) => OllamaRuntimeModelStatus;
  runCaptureExImpl?: RunCaptureExFn;
  getOllamaHost?: () => string;
  runCaptureImpl?: OllamaRuntimeRunCaptureFn;
}

export type OllamaRestartRecoveryResult =
  | { kind: "skipped"; reason: "not-ollama" | "missing-model" | "already-loaded" | "unreachable" }
  | { kind: "warmed"; ok: boolean; timedOut: boolean };

const OLLAMA_PROVIDER = "ollama-local";
const OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS = 300;

/**
 * Converts optional route metadata into a comparable string value.
 */
function normalizeRouteValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Best-effort recovery for the local-Ollama agent path after a daemon restart.
 *
 * Killing Ollama drops the model runner even after the daemon comes back. The
 * first post-restart OpenClaw agent request can then spend its whole request
 * budget cold-loading the model and exit non-zero. We only warm when `/api/ps`
 * proves the daemon is reachable but the selected model is not loaded, so a
 * genuinely down backend still reaches OpenClaw's existing clear
 * backend-unavailable error without an added long probe delay.
 */
export function maybeWarmOllamaAfterDaemonRestart(
  route: OllamaRestartRecoveryRoute,
  deps: OllamaRestartRecoveryDeps = {},
): OllamaRestartRecoveryResult {
  if (normalizeRouteValue(route.provider) !== OLLAMA_PROVIDER) {
    return { kind: "skipped", reason: "not-ollama" };
  }

  const model = normalizeRouteValue(route.model);
  if (!model) {
    return { kind: "skipped", reason: "missing-model" };
  }

  const probe = deps.probeRuntimeModelStatus ?? probeOllamaRuntimeModelStatus;
  let status: OllamaRuntimeModelStatus;
  try {
    status = probe(model, deps.getOllamaHost ?? getResolvedOllamaHost, deps.runCaptureImpl);
  } catch {
    return { kind: "skipped", reason: "unreachable" };
  }
  if (!status.probed) {
    return { kind: "skipped", reason: "unreachable" };
  }
  if (status.loaded) {
    return { kind: "skipped", reason: "already-loaded" };
  }

  const captureEx = deps.runCaptureExImpl ?? runCaptureEx;
  try {
    const result = captureEx(getOllamaProbeCommand(model, OLLAMA_RESTART_RECOVERY_TIMEOUT_SECONDS));
    return { kind: "warmed", ok: Boolean(result.stdout), timedOut: result.timedOut };
  } catch {
    return { kind: "warmed", ok: false, timedOut: false };
  }
}
