// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const PUBLISHED_HOST_PORT = 46_145;

vi.mock("../adapters/docker/container", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/container")>()),
  dockerPort: vi.fn(() => `0.0.0.0:${PUBLISHED_HOST_PORT}\n[::]:${PUBLISHED_HOST_PORT}\n`),
}));

import { probeLocalProviderHealth } from "./local";

describe("managed vLLM status probe port resolution", () => {
  it("probes the published host port of the managed container, not the default", () => {
    const probedArgv: string[] = [];

    probeLocalProviderHealth("vllm-local", {
      model: "served-model",
      // An unauthenticated managed container yields no recovered binding, which
      // is the state reported in #11374 for a custom NEMOCLAW_VLLM_PORT run.
      getManagedVllmBaseUrlImpl: () => null,
      loadVllmApiKeyImpl: () => null,
      runCurlProbeImpl: (argv) => {
        probedArgv.push(...argv);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"data":[{"id":"served-model"}]}',
          stderr: "",
          message: "HTTP 200",
        };
      },
    });

    const endpoint = probedArgv.find((arg) => arg.includes("/v1/models")) ?? "";
    expect(endpoint).toContain(`:${PUBLISHED_HOST_PORT}`);
  });
});
