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
  error?: (message: string) => void;
  exit?: (code: number) => never;
};

const REASONING_ENV = "NEMOCLAW_REASONING";

/** Normalizes the reasoning-mode environment value accepted by Option 3 onboarding. */
export function normalizeReasoningMode(value: string | undefined): "true" | "false" | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "false") return normalized;
  return null;
}

/** Resolves and records whether an OpenAI-compatible endpoint should use reasoning mode. */
export async function configureCustomOpenAiReasoningMode(deps: ReasoningModeDeps): Promise<void> {
  const env = deps.env || process.env;
  const existing = String(env[REASONING_ENV] ?? "").trim();
  if (existing) {
    const normalized = normalizeReasoningMode(existing);
    if (!normalized) {
      throw new Error(
        `${REASONING_ENV} must be "true" or "false" for OpenAI-compatible endpoints.`,
      );
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

/** Applies reasoning-mode configuration and exits through the onboarding error path on invalid input. */
export async function configureCustomOpenAiReasoningModeOrExit(
  deps: ReasoningModeExitDeps,
): Promise<void> {
  try {
    await configureCustomOpenAiReasoningMode(deps);
  } catch (err) {
    const error = deps.error ?? console.error;
    const exit = deps.exit ?? process.exit;
    error(`  ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
  }
}
