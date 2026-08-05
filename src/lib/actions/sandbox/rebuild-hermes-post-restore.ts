// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import * as processRecovery from "./process-recovery";

const HERMES_CRON_CONTROL = "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const DRAIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const BEGIN_TIMEOUT_MS = 70_000;
const CONTROL_TIMEOUT_MS = 25_000;

interface HermesCronRestoreReceipt {
  version: 1;
  action: "begin" | "validate" | "release";
  pid: number;
  start_time: number;
  drain_acquired: boolean;
  drain_token?: string;
}

type HermesCronRestoreIdentity = Pick<
  HermesCronRestoreReceipt,
  "pid" | "start_time" | "drain_token"
>;

export class HermesCronRestoreIncompleteError extends Error {
  constructor() {
    super("Hermes state restore was incomplete while cron dispatch was drained");
    this.name = "HermesCronRestoreIncompleteError";
  }
}

export type HermesPostRestoreGatewayState =
  | "not-applicable"
  | "healthy"
  | "recovered"
  | "unverified";

type GatewayRecoveryObservation = {
  checked: boolean;
  wasRunning: boolean | null;
  recovered: boolean;
  forwardRecoveryFailed?: boolean;
  secretBoundaryRefused?: boolean;
  mcpReconciliationRefused?: boolean;
};

interface HermesPostRestoreGatewayDeps {
  checkAndRecoverSandboxProcesses?: (
    sandboxName: string,
    options: { quiet: boolean },
  ) => GatewayRecoveryObservation;
}

/**
 * Re-prove Hermes gateway health after workspace state restoration.
 *
 * Inner onboarding verifies the fresh image before rebuild restores the prior
 * state. That restore can still stop or wedge the gateway, so its earlier
 * readiness message is not authoritative for rebuild completion.
 */
export function ensureHermesGatewayAfterStateRestore(
  sandboxName: string,
  agentName: string,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  if (agentName !== "hermes") return "not-applicable";
  const checkAndRecover =
    deps.checkAndRecoverSandboxProcesses ?? processRecovery.checkAndRecoverSandboxProcesses;
  const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, { quiet: true });
  if (
    !observation.checked ||
    observation.forwardRecoveryFailed === true ||
    observation.secretBoundaryRefused === true ||
    observation.mcpReconciliationRefused === true
  ) {
    return "unverified";
  }
  if (observation.wasRunning === true) return "healthy";
  if (observation.recovered) return "recovered";
  return "unverified";
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — run \`${CLI_NAME} ${sandboxName} recover\` before relying on this sandbox`,
  );
}

function parseCronRestoreReceipt(
  stdout: string,
  expectedAction: HermesCronRestoreReceipt["action"],
): HermesCronRestoreReceipt {
  const receiptLines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (receiptLines.length !== 1) {
    throw new Error(`Hermes cron ${expectedAction} returned an invalid receipt`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(receiptLines[0].slice(RECEIPT_PREFIX.length));
  } catch {
    throw new Error(`Hermes cron ${expectedAction} returned malformed JSON`);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { version?: unknown }).version !== 1 ||
    (payload as { action?: unknown }).action !== expectedAction ||
    !Number.isSafeInteger((payload as { pid?: unknown }).pid) ||
    Number((payload as { pid: number }).pid) <= 0 ||
    !Number.isSafeInteger((payload as { start_time?: unknown }).start_time) ||
    Number((payload as { start_time: number }).start_time) < 0 ||
    typeof (payload as { drain_acquired?: unknown }).drain_acquired !== "boolean" ||
    ((payload as { drain_acquired: boolean }).drain_acquired
      ? typeof (payload as { drain_token?: unknown }).drain_token !== "string" ||
        !DRAIN_TOKEN_PATTERN.test((payload as { drain_token: string }).drain_token)
      : "drain_token" in payload)
  ) {
    throw new Error(`Hermes cron ${expectedAction} receipt failed validation`);
  }
  return payload as HermesCronRestoreReceipt;
}

function runCronRestoreControl(
  sandboxName: string,
  action: HermesCronRestoreReceipt["action"],
  identity?: HermesCronRestoreIdentity,
): HermesCronRestoreReceipt {
  const identityArgs = identity
    ? ` --pid ${String(identity.pid)} --start-time ${String(identity.start_time)}${identity.drain_token ? ` --drain-token '${identity.drain_token}'` : ""}`
    : "";
  const command = `${HERMES_PYTHON} -I ${HERMES_CRON_CONTROL} ${action}${identityArgs}`;
  const result = processRecovery.executeSandboxExecCommand(
    sandboxName,
    command,
    action === "begin" ? BEGIN_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
  );
  if (!result) {
    throw new Error(`Hermes cron ${action} transport was unavailable`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/u).at(-1);
    throw new Error(`Hermes cron ${action} failed${detail ? `: ${detail}` : ""}`);
  }
  return parseCronRestoreReceipt(result.stdout, action);
}

export function beginHermesCronRestore(sandboxName: string): HermesCronRestoreIdentity {
  const receipt = runCronRestoreControl(sandboxName, "begin");
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

export function validateHermesCronRestore(
  sandboxName: string,
  identity: HermesCronRestoreIdentity,
): void {
  const receipt = runCronRestoreControl(sandboxName, "validate", identity);
  if (
    receipt.pid !== identity.pid ||
    receipt.start_time !== identity.start_time ||
    receipt.drain_token !== identity.drain_token
  ) {
    throw new Error("Hermes cron validate receipt changed gateway identity");
  }
}

export function releaseHermesCronRestore(
  sandboxName: string,
  identity: HermesCronRestoreIdentity,
): void {
  const receipt = runCronRestoreControl(sandboxName, "release", identity);
  if (
    receipt.pid !== identity.pid ||
    receipt.start_time !== identity.start_time ||
    receipt.drain_token !== identity.drain_token
  ) {
    throw new Error("Hermes cron release receipt changed gateway identity");
  }
}

export function runHermesCronRestoreTransaction<T extends { restoreSucceeded: boolean }>(
  sandboxName: string,
  restore: () => T,
  onGateTransition: (
    state: "acquired" | "released",
    identity: HermesCronRestoreIdentity,
  ) => void = () => {},
): T {
  const identity = beginHermesCronRestore(sandboxName);
  onGateTransition("acquired", identity);
  const result = restore();
  if (!result.restoreSucceeded) {
    throw new HermesCronRestoreIncompleteError();
  }
  validateHermesCronRestore(sandboxName, identity);
  releaseHermesCronRestore(sandboxName, identity);
  onGateTransition("released", identity);
  return result;
}
