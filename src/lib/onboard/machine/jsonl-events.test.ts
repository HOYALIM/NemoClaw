// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addOnboardMachineEventListener,
  clearOnboardMachineEventListeners,
  emitOnboardMachineEvent,
  type OnboardMachineEvent,
} from "./events";
import {
  observeOnboardJsonlEvents,
  toOnboardJsonlEvent,
  withOnboardJsonlEventStream,
} from "./jsonl-events";

const SECRET = "sk-test-1234567890abcdefghijklmnop";

function sampleEvent(overrides: Partial<OnboardMachineEvent> = {}): OnboardMachineEvent {
  return {
    version: 1,
    type: "state.entered",
    occurredAt: "2026-07-13T12:34:56.789Z",
    sessionId: "session-6403",
    state: "inference",
    step: "inference",
    context: {
      agent: "openclaw",
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/test-model",
      endpointOrigin: "https://integrate.api.nvidia.com",
      credentialEnv: "NVIDIA_API_KEY",
    },
    error: null,
    metadata: {},
    ...overrides,
  };
}

afterEach(() => {
  clearOnboardMachineEventListeners();
  vi.restoreAllMocks();
});

describe("onboard JSONL events", () => {
  it("uses the stable versioned envelope and redacts payload secrets", () => {
    const event = toOnboardJsonlEvent(
      sampleEvent({
        error: `provider rejected Bearer ${SECRET}`,
        metadata: {
          apiKey: SECRET,
          endpoint: `https://alice:${SECRET}@example.com/v1?token=${SECRET}`,
        },
      }),
    );

    expect(Object.keys(event)).toEqual([
      "schemaVersion",
      "session",
      "type",
      "timestamp",
      "payload",
    ]);
    expect(event).toMatchObject({
      schemaVersion: 1,
      session: "session-6403",
      type: "state.entered",
      timestamp: "2026-07-13T12:34:56.789Z",
      payload: {
        state: "inference",
        step: "inference",
        context: { sandboxName: "alpha", credentialEnv: "NVIDIA_API_KEY" },
      },
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.payload.metadata).toEqual({
      apiKey: "<REDACTED>",
      endpoint: "https://example.com/v1?token=<REDACTED>",
    });
  });

  it("writes exactly one parseable JSON object per observed event line", () => {
    const lines: string[] = [];
    const stop = observeOnboardJsonlEvents((line) => {
      lines.push(line);
    });

    emitOnboardMachineEvent(sampleEvent());
    emitOnboardMachineEvent(sampleEvent({ type: "state.completed" }));
    stop();

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(line)).toMatchObject({ schemaVersion: 1, session: "session-6403" });
    }
  });

  it("keeps human progress off stdout while event mode is active", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const jsonl: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    await withOnboardJsonlEventStream(
      async () => {
        process.stdout.write("human progress\n");
        emitOnboardMachineEvent(sampleEvent());
      },
      (line) => {
        jsonl.push(line);
      },
    );

    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("human progress");
    expect(JSON.parse(jsonl.join(""))).toMatchObject({ type: "state.entered" });
  });

  it("ignores a closed event pipe and lets canonical observers and onboarding continue", async () => {
    const canonicalEvents: string[] = [];
    let writes = 0;
    addOnboardMachineEventListener((event) => canonicalEvents.push(event.type));

    const result = await withOnboardJsonlEventStream(
      async () => {
        emitOnboardMachineEvent(sampleEvent());
        emitOnboardMachineEvent(sampleEvent({ type: "state.completed" }));
        return "onboarding-completed";
      },
      () => {
        writes += 1;
        throw Object.assign(new Error("closed pipe"), { code: "EPIPE" });
      },
    );

    expect(result).toBe("onboarding-completed");
    expect(writes).toBe(1);
    expect(canonicalEvents).toEqual(["state.entered", "state.completed"]);
  });

  it("disables observation on backpressure without stalling canonical onboarding", () => {
    const canonicalEvents: string[] = [];
    let writes = 0;
    addOnboardMachineEventListener((event) => canonicalEvents.push(event.type));
    observeOnboardJsonlEvents(() => {
      writes += 1;
      return false;
    });

    emitOnboardMachineEvent(sampleEvent());
    emitOnboardMachineEvent(sampleEvent({ type: "state.completed" }));

    expect(writes).toBe(1);
    expect(canonicalEvents).toEqual(["state.entered", "state.completed"]);
  });

  it("restores stdout and removes observation when onboarding rejects", async () => {
    const jsonl: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const stdoutWrite = process.stdout.write;
    const failure = new Error("onboarding failed");

    await expect(
      withOnboardJsonlEventStream(
        async () => {
          process.stdout.write("human failure detail\n");
          emitOnboardMachineEvent(sampleEvent());
          throw failure;
        },
        (line) => {
          jsonl.push(line);
        },
      ),
    ).rejects.toBe(failure);

    expect(process.stdout.write).toBe(stdoutWrite);
    expect(stderr.join("")).toContain("human failure detail");
    expect(jsonl).toHaveLength(1);
    emitOnboardMachineEvent(sampleEvent({ type: "state.completed" }));
    expect(jsonl).toHaveLength(1);
  });
});
