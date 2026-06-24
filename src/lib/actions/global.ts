// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../adapters/openshell/runtime";
import {
  type GarbageCollectImagesOptions,
  type UpgradeSandboxesOptions,
} from "../domain/lifecycle/options";
import { recoverNamedGatewayRuntime as recoverNamedGatewayRuntimeAction } from "../gateway-runtime-action";
import { runDeployAction as executeDeployAction } from "./deploy";
import {
  backupAll as executeBackupAllAction,
  garbageCollectImages as executeGarbageCollectImagesAction,
} from "./maintenance";
import {
  runOnboardAction as executeOnboardAction,
  runSetupAction as executeSetupAction,
  runSetupSparkAction as executeSetupSparkAction,
} from "./onboard";
import { help, version } from "./root-help";
import { recordMetricEvent } from "../metrics";

type GatewayRecovery = { recovered: boolean };

type GlobalCliActionRuntimeHooks = {
  recoverNamedGatewayRuntime?: () => Promise<GatewayRecovery>;
  runOpenshell?: typeof runOpenshell;
  upgradeSandboxes?: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
};

let runtimeHooks: GlobalCliActionRuntimeHooks = {};

export function setGlobalCliActionRuntimeHooksForTest(hooks: GlobalCliActionRuntimeHooks): void {
  runtimeHooks = hooks;
}

function shouldRecordOnboardLifecycle(args: readonly string[]): boolean {
  return !args.includes("--help") && !args.includes("-h");
}

async function runWithOnboardMetrics(
  args: string[],
  command: string,
  runCommand: () => Promise<void>,
): Promise<void> {
  const shouldRecord = shouldRecordOnboardLifecycle(args);
  let completeRecorded = false;
  const recordComplete = (status: "success" | "failed"): void => {
    completeRecorded = true;
    recordMetricEvent("onboard_complete", { command, status });
  };
  const recordCompleteOnExit = (code: number): void => {
    if (shouldRecord && !completeRecorded) {
      recordComplete(code === 0 ? "success" : "failed");
    }
  };

  if (shouldRecord) {
    recordMetricEvent("onboard_start", {
      command,
      data: { nonInteractive: args.includes("--non-interactive") },
    });
    process.once("exit", recordCompleteOnExit);
  }

  try {
    await runCommand();
    if (shouldRecord) {
      process.removeListener("exit", recordCompleteOnExit);
      recordComplete("success");
    }
  } catch (error) {
    if (shouldRecord) {
      process.removeListener("exit", recordCompleteOnExit);
      recordComplete("failed");
    }
    throw error;
  }
}

export async function runOnboardAction(args: string[] = []): Promise<void> {
  await runWithOnboardMetrics(args, "onboard", () => executeOnboardAction(args));
}

export async function runSetupAction(args: string[] = []): Promise<void> {
  await runWithOnboardMetrics(args, "setup", () => executeSetupAction(args));
}

export async function runSetupSparkAction(args: string[] = []): Promise<void> {
  await runWithOnboardMetrics(args, "setup-spark", () => executeSetupSparkAction(args));
}

export async function runDeployAction(instanceName?: string): Promise<void> {
  await executeDeployAction(instanceName);
}

export async function runBackupAllAction(): Promise<void> {
  await executeBackupAllAction();
}

export async function runUpgradeSandboxesAction(
  options: string[] | UpgradeSandboxesOptions = {},
): Promise<void> {
  if (typeof runtimeHooks.upgradeSandboxes === "function") {
    await runtimeHooks.upgradeSandboxes(options);
    return;
  }
  const { upgradeSandboxes } = require("./upgrade-sandboxes") as {
    upgradeSandboxes: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
  };
  await upgradeSandboxes(options);
}

export async function runGarbageCollectImagesAction(
  options: string[] | GarbageCollectImagesOptions = {},
): Promise<void> {
  await executeGarbageCollectImagesAction(options);
}

export function showRootHelp(): void {
  help();
}

export function showVersion(): void {
  version();
}

export async function recoverNamedGatewayRuntime(): Promise<GatewayRecovery> {
  if (typeof runtimeHooks.recoverNamedGatewayRuntime === "function") {
    return runtimeHooks.recoverNamedGatewayRuntime();
  }
  return recoverNamedGatewayRuntimeAction();
}

export function runOpenshellProviderCommand(
  args: string[],
  opts?: {
    env?: Record<string, string | undefined>;
    ignoreError?: boolean;
    stdio?: import("node:child_process").StdioOptions;
    timeout?: number;
  },
) {
  if (typeof runtimeHooks.runOpenshell === "function") {
    return runtimeHooks.runOpenshell(args, opts);
  }
  return runOpenshell(args, opts);
}
