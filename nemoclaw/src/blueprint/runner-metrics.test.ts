// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type fs from "node:fs";

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();
const mockExeca = vi.fn();

vi.mock("node:os", () => ({
  homedir: () => "/fakehome",
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn((p: string) => {
      store.set(p, { type: "dir" });
    }),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      return entry?.type === "file" ? (entry.content ?? "") : throwFsError(p);
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const entries = new Set<string>();
      for (const key of store.keys()) {
        const [first] = key.slice(prefix.length).split("/");
        key.startsWith(prefix) && first !== undefined && first !== "" && entries.add(first);
      }
      entries.size === 0 && !store.has(p) && throwFsError(p);
      return [...entries].sort();
    },
  };
});

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", () => ({
  validateEndpointUrl: vi.fn(async (url: string) => ({ url, pinnedUrl: url })),
}));

const { validateEndpointUrl } = await import("./ssrf.js");
const mockedValidateEndpoint = vi.mocked(validateEndpointUrl);
const { metrics } = await import("../observability/metrics.js");
const { actionApply, actionPlan } = await import("./runner.js");

const stdoutChunks: string[] = [];

function throwFsError(path: string): never {
  throw new Error(`ENOENT: ${path}`);
}

function captureStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
}

function minimalBlueprint(): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
  };
}

describe("runner metrics", () => {
  beforeEach(() => {
    store.clear();
    stdoutChunks.length = 0;
    vi.clearAllMocks();
    vi.stubEnv("NEMOCLAW_METRICS_ENABLED", "true");
    metrics.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    metrics.reset();
  });

  it("records blueprint and endpoint validation metrics for successful plans", async () => {
    captureStdout();
    mockExeca.mockResolvedValue({ exitCode: 0 });

    await actionPlan("default", minimalBlueprint());

    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'blueprint_execution_total{action="plan",profile="default",status="success"} 1',
    );
    expect(output).toContain(
      'blueprint_execution_duration_seconds_count{action="plan",profile="default",status="success"} 1',
    );
    expect(output).toContain(
      'api_validation_total{kind="endpoint_url",source="blueprint",status="success"} 1',
    );
  });

  it("records blueprint and endpoint validation metrics for failed plans", async () => {
    captureStdout();
    mockExeca.mockResolvedValue({ exitCode: 0 });
    mockedValidateEndpoint.mockRejectedValueOnce(new Error("SSRF blocked"));

    await expect(actionPlan("default", minimalBlueprint())).rejects.toThrow("SSRF blocked");

    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'blueprint_execution_total{action="plan",profile="default",status="error"} 1',
    );
    expect(output).toContain(
      'api_validation_total{kind="endpoint_url",source="blueprint",status="error"} 1',
    );
  });

  it("records sandbox lifecycle metrics during apply", async () => {
    captureStdout();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await actionApply("default", minimalBlueprint());

    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'blueprint_execution_total{action="apply",profile="default",status="success"} 1',
    );
    expect(output).toContain('sandbox_lifecycle_total{operation="create",status="success"} 1');
    expect(output).toContain(
      'sandbox_lifecycle_duration_seconds_count{operation="create",status="success"} 1',
    );
  });
});
