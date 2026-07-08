// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntilAsync } from "../core/wait";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string;

export interface GatewayHealthWaitOptions {
  attachGatewayMetadataIfNeeded: (options?: { forceRefresh?: boolean }) => void;
  gatewayClusterHealthcheckPassed: () => boolean;
  gatewayName: string;
  healthPollCount: number;
  healthPollIntervalSeconds: number;
  isGatewayHealthy: (status: string, namedInfo: string, currentInfo: string) => boolean;
  isGatewayHttpReady: () => Promise<boolean>;
  repairGatewayBootstrapSecrets: () => { repaired: boolean };
  runCaptureOpenshell: RunCaptureOpenshell;
  sleepSeconds: (seconds: number) => void;
  now?: () => number;
}

export function getGatewayHealthWaitBudgetMs(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): number {
  const normalizedCount = Number.isFinite(healthPollCount) ? Math.max(0, healthPollCount) : 0;
  const normalizedIntervalSeconds = Number.isFinite(healthPollIntervalSeconds)
    ? Math.max(0, healthPollIntervalSeconds)
    : 0;
  return normalizedCount <= 0 ? 0 : Math.max(1, normalizedCount * normalizedIntervalSeconds * 1000);
}

export function formatGatewayHealthWaitBudget(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): string {
  const budgetMs = getGatewayHealthWaitBudgetMs(healthPollCount, healthPollIntervalSeconds);
  if (budgetMs <= 0) return "0s";
  if (budgetMs < 1000) return `${Math.ceil(budgetMs)}ms`;
  const seconds = budgetMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

export async function waitForGatewayHealth({
  attachGatewayMetadataIfNeeded,
  gatewayClusterHealthcheckPassed,
  gatewayName,
  healthPollCount,
  healthPollIntervalSeconds,
  isGatewayHealthy,
  isGatewayHttpReady,
  repairGatewayBootstrapSecrets,
  runCaptureOpenshell,
  sleepSeconds,
  now = Date.now,
}: GatewayHealthWaitOptions): Promise<boolean> {
  const healthPollIntervalMs = Math.max(0, healthPollIntervalSeconds * 1000);
  const waitBudgetMs = getGatewayHealthWaitBudgetMs(healthPollCount, healthPollIntervalSeconds);
  return (
    healthPollCount > 0 &&
    (await waitUntilAsync(
      async () => {
        const repairResult = repairGatewayBootstrapSecrets();
        if (repairResult.repaired) {
          attachGatewayMetadataIfNeeded({ forceRefresh: true });
        } else if (gatewayClusterHealthcheckPassed()) {
          attachGatewayMetadataIfNeeded();
        }
        runCaptureOpenshell(["gateway", "select", gatewayName], { ignoreError: true });
        const status = runCaptureOpenshell(["status"], { ignoreError: true });
        const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
        return isGatewayHealthy(status, namedInfo, currentInfo) && (await isGatewayHttpReady());
      },
      {
        deadlineMs: now() + waitBudgetMs,
        initialIntervalMs: healthPollIntervalMs,
        maxIntervalMs: healthPollIntervalMs,
        backoffFactor: 1,
        now,
        sleep: (ms) => sleepSeconds(ms / 1000),
      },
    ))
  );
}
