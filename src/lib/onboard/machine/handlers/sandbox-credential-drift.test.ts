// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import { hashCredential } from "../../../security/credential-hash";
import { createSession } from "../../../state/onboard-session";
import { recordCheckpointMessaging } from "../../checkpoint-record";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
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
const previousHome = process.env.HOME;
let registryHome = "";
let registry: typeof import("../../../state/registry");
let handleSandboxState: typeof import("./sandbox").handleSandboxState;

beforeAll(async () => {
  registryHome = await mkdtemp(path.join(os.tmpdir(), "nemoclaw-credential-drift-"));
  process.env.HOME = registryHome;
  ({ handleSandboxState } = await import("./sandbox"));
  registry = await import("../../../state/registry");

  const registryPath = path.relative(registryHome, registry.REGISTRY_FILE);
  if (registryPath.startsWith("..") || path.isAbsolute(registryPath)) {
    throw new Error("Credential-drift test registry did not resolve under its temporary home.");
  }
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (registryHome) await rm(registryHome, { recursive: true, force: true });
});

describe("sandbox messaging credential drift", () => {
  beforeEach(() => {
    registry.clearAll();
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
    registry.registerSandbox({
      name: "saved",
      messaging: { schemaVersion: 1, plan: previousPlan },
    });
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);
    const messagingEnv: NodeJS.ProcessEnv = {};
    const readMessagingPlanFromEnv = () =>
      MessagingSetupApplier.readPlanFromEnv({ env: messagingEnv });
    const writePlanToEnv = (plan: typeof replacementPlan) =>
      MessagingSetupApplier.writePlanToEnv(plan, { env: messagingEnv });
    const { deps, calls, getSession } = createDeps({
      getSandboxReuseState: () => "ready",
      getRegistrySandboxMessagingPlan: (name) =>
        registry.getHydratedMessagingPlanFromEntry(registry.getSandbox(name)),
      getRecordedMessagingChannelsForResume: () => null,
      readMessagingPlanFromEnv,
      writePlanToEnv,
      listRegistrySandboxes: registry.listSandboxes,
    });
    calls.removeSandbox.mockImplementation(() => registry.removeSandboxWithReceipt("saved"));
    calls.setupMessaging.mockImplementation(async () => {
      writePlanToEnv(replacementPlan);
      return ["telegram"];
    });
    calls.createSandbox.mockImplementation(async () => {
      const plan = readMessagingPlanFromEnv();
      registry.registerSandbox({
        name: "saved",
        messaging: plan ? { schemaVersion: 1, plan } : undefined,
      });
      return "saved";
    });

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
    const registryState = registry.listSandboxes();
    expect(registryState.sandboxes).toHaveLength(1);
    expect(registryState.sandboxes[0]?.name).toBe("saved");
    expect(
      registryState.sandboxes[0]?.messaging?.plan.credentialBindings.map(
        (binding) => binding.credentialHash,
      ),
    ).toEqual([hashCredential(replacementToken)]);
    const serializedRegistry = JSON.stringify(registryState);
    expect(serializedRegistry).not.toContain(hashCredential(previousToken));
    expect(serializedRegistry).not.toContain(previousToken);
    expect(serializedRegistry).not.toContain(replacementToken);
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
