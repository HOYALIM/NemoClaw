// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCredential } from "../../../security/credential-hash";
import { createSession } from "../../../state/onboard-session";
import { recordCheckpointMessaging } from "../../checkpoint-record";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
  withEnv,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

// Messaging discovery is mocked at import time to isolate credential-drift resume behavior.
vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

const detectMessagingChannelsFromEnvMock = vi.mocked(detectMessagingChannelsFromEnv);

describe("sandbox messaging credential drift", () => {
  beforeEach(() => {
    detectMessagingChannelsFromEnvMock.mockReturnValue([]);
  });

  it("validates a changed credential before reusing a ready sandbox (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const replacementPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(replacementToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: previousPlan });
    session.steps.sandbox.status = "complete";
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    const readMessagingPlanFromEnv = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(replacementPlan);
    const { deps, calls, getSession } = createDeps({
      getSandboxReuseState: () => "ready",
      getRegistrySandboxMessagingPlan: () => previousPlan,
      getRecordedMessagingChannelsForResume: () => null,
      readMessagingPlanFromEnv,
    });
    calls.setupMessaging.mockResolvedValue(["telegram"]);

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Messaging credential changed; validating and recreating sandbox.",
    );
    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.createSandbox).toHaveBeenCalled();
    expect(getSession().messagingPlan?.credentialBindings[0]?.credentialHash).toBe(
      hashCredential(replacementToken),
    );
  });

  it("validates registry-only credential drift before removing the sandbox (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:rejected-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    session.sandboxPromptProgress.messaging = true;
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingPlan: () => previousPlan,
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );
    calls.setupMessaging.mockRejectedValueOnce(new Error("Bot token was rejected by Telegram"));

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "saved",
          env: { TELEGRAM_BOT_TOKEN: replacementToken },
        }),
      ).rejects.toThrow("Bot token was rejected by Telegram");
    });

    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps an explicitly disabled checkpoint channel disabled when registry credentials drift (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const disabledPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"], ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: disabledPlan });
    session.steps.sandbox.status = "complete";
    session.machine = { ...session.machine, state: "agent_setup" };
    session.sandboxPromptProgress.messaging = true;
    recordCheckpointMessaging(session, disabledPlan);
    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingPlan: () => registryPlan,
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(disabledPlan);
  });
});
