// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ReasoningModeDeps = {
  env?: NodeJS.ProcessEnv;
  isNonInteractive: () => boolean;
  promptYesNoOrDefault: (
    question: string,
    envVar: string | null,
    defaultIsYes: boolean,
  ) => Promise<boolean>;
  note?: (message: string) => void;
};

export type ReasoningModeExitDeps = ReasoningModeDeps & {
  error: (message: string) => void;
  exit: (code: number) => never;
};

const REASONING_ENV = "NEMOCLAW_REASONING";

export function normalizeReasoningMode(value: string | undefined): "true" | "false" | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "false") return normalized;
  return null;
}

export async function configureCustomOpenAiReasoningMode(deps: ReasoningModeDeps): Promise<void> {
  const env = deps.env || process.env;
  const existing = String(env[REASONING_ENV] ?? "").trim();
  if (existing) {
    const normalized = normalizeReasoningMode(existing);
    if (!normalized) {
      throw new Error(`${REASONING_ENV} must be "true" or "false" for OpenAI-compatible endpoints.`);
    }
    env[REASONING_ENV] = normalized;
    if (deps.isNonInteractive()) {
      deps.note?.(`  [non-interactive] OpenAI-compatible reasoning mode -> ${normalized}`);
    }
    return;
  }

  const enabled = await deps.promptYesNoOrDefault(
    "  Enable reasoning mode for this OpenAI-compatible model?",
    REASONING_ENV,
    false,
  );
  env[REASONING_ENV] = enabled ? "true" : "false";
  if (enabled) {
    deps.note?.("  OpenAI-compatible reasoning mode enabled.");
  }
}

export async function configureCustomOpenAiReasoningModeOrExit(
  deps: ReasoningModeExitDeps,
): Promise<void> {
  try {
    await configureCustomOpenAiReasoningMode(deps);
  } catch (err) {
    deps.error(`  ${err instanceof Error ? err.message : String(err)}`);
    deps.exit(1);
  }
}
