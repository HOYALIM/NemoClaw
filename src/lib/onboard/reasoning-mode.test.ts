// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { configureCustomOpenAiReasoningMode, normalizeReasoningMode } from "./reasoning-mode";

describe("OpenAI-compatible reasoning mode onboarding", () => {
  it("normalizes valid NEMOCLAW_REASONING values", () => {
    expect(normalizeReasoningMode("true")).toBe("true");
    expect(normalizeReasoningMode(" FALSE ")).toBe("false");
    expect(normalizeReasoningMode("yes")).toBe(null);
  });

  it("uses an existing non-interactive NEMOCLAW_REASONING override without prompting", async () => {
    const env = { NEMOCLAW_REASONING: " TRUE " } as NodeJS.ProcessEnv;
    const promptYesNoOrDefault = vi.fn();
    const note = vi.fn();

    await configureCustomOpenAiReasoningMode({
      env,
      isNonInteractive: () => true,
      promptYesNoOrDefault,
      note,
    });

    expect(env.NEMOCLAW_REASONING).toBe("true");
    expect(promptYesNoOrDefault).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "  [non-interactive] OpenAI-compatible reasoning mode -> true",
    );
  });

  it("prompts Option 3 users and writes NEMOCLAW_REASONING", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const promptYesNoOrDefault = vi.fn(async () => true);
    const note = vi.fn();

    await configureCustomOpenAiReasoningMode({
      env,
      isNonInteractive: () => false,
      promptYesNoOrDefault,
      note,
    });

    expect(promptYesNoOrDefault).toHaveBeenCalledWith(
      "  Enable reasoning mode for this OpenAI-compatible model?",
      "NEMOCLAW_REASONING",
      false,
    );
    expect(env.NEMOCLAW_REASONING).toBe("true");
    expect(note).toHaveBeenCalledWith("  OpenAI-compatible reasoning mode enabled.");
  });

  it("rejects invalid NEMOCLAW_REASONING values with an actionable error", async () => {
    await expect(
      configureCustomOpenAiReasoningMode({
        env: { NEMOCLAW_REASONING: "maybe" } as NodeJS.ProcessEnv,
        isNonInteractive: () => true,
        promptYesNoOrDefault: vi.fn(),
      }),
    ).rejects.toThrow('NEMOCLAW_REASONING must be "true" or "false"');
  });
});
