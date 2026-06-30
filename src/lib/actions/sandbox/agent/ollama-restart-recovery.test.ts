// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { maybeWarmOllamaAfterDaemonRestart } from "./ollama-restart-recovery";

describe("maybeWarmOllamaAfterDaemonRestart", () => {
  it("skips non-Ollama routes", () => {
    const runCaptureExImpl = vi.fn();

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "vllm-local", model: "meta/llama" },
      { runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "skipped", reason: "not-ollama" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips Ollama routes without a selected model", () => {
    const runCaptureExImpl = vi.fn();

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "  " },
      { runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "skipped", reason: "missing-model" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips while Ollama is unreachable so backend-unavailable stays fast", () => {
    const runCaptureExImpl = vi.fn();
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: false,
      loaded: false,
      cpuOnly: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      { probeRuntimeModelStatus, runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "skipped", reason: "unreachable" });
    expect(probeRuntimeModelStatus).toHaveBeenCalledWith(
      "qwen3.6:35b",
      expect.any(Function),
      undefined,
    );
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips when the runtime status probe throws", () => {
    const runCaptureExImpl = vi.fn();
    const probeRuntimeModelStatus = vi.fn(() => {
      throw new Error("curl probe failed");
    });

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      { probeRuntimeModelStatus, runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "skipped", reason: "unreachable" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("skips when the selected Ollama model is already loaded", () => {
    const runCaptureExImpl = vi.fn();
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: true,
      cpuOnly: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      { probeRuntimeModelStatus, runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "skipped", reason: "already-loaded" });
    expect(runCaptureExImpl).not.toHaveBeenCalled();
  });

  it("warms when Ollama is reachable but the selected model is not loaded", () => {
    const runCaptureExImpl = vi.fn(() => ({
      stdout: '{"done":true}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: false,
      cpuOnly: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      {
        getOllamaHost: () => "127.0.0.1",
        probeRuntimeModelStatus,
        runCaptureExImpl,
      },
    );

    expect(result).toEqual({ kind: "warmed", ok: true, timedOut: false });
    expect(runCaptureExImpl).toHaveBeenCalledTimes(1);
    const [command] = runCaptureExImpl.mock.calls[0] as unknown as [string[]];
    expect(command).toContain("--max-time");
    expect(command).toContain("300");
    expect(command).toContain("http://127.0.0.1:11434/api/generate");
    expect(command.join("\n")).toContain('"model":"qwen3.6:35b"');
  });

  it("uses the host-aware runtime probe before warming", () => {
    const runCaptureImpl = vi.fn((cmd: string | string[]) => {
      const command = Array.isArray(cmd) ? cmd.join(" ") : cmd;
      expect(command).toContain("http://192.0.2.44:11434/api/ps");
      return JSON.stringify({ models: [] });
    });
    const runCaptureExImpl = vi.fn(() => ({
      stdout: '{"done":true}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      {
        getOllamaHost: () => "192.0.2.44",
        runCaptureImpl,
        runCaptureExImpl,
      },
    );

    expect(result).toEqual({ kind: "warmed", ok: true, timedOut: false });
    expect(runCaptureImpl).toHaveBeenCalledTimes(1);
    expect(runCaptureExImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a failed warm result without throwing when the warmup probe has no output", () => {
    const runCaptureExImpl = vi.fn(() => ({
      stdout: "",
      stderr: "curl: (28) Operation timed out",
      exitCode: 28,
      timedOut: true,
    }));
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: false,
      cpuOnly: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      { probeRuntimeModelStatus, runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "warmed", ok: false, timedOut: true });
  });

  it("returns a failed warm result without throwing when the warmup probe throws", () => {
    const runCaptureExImpl = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const probeRuntimeModelStatus = vi.fn(() => ({
      probed: true,
      loaded: false,
      cpuOnly: false,
    }));

    const result = maybeWarmOllamaAfterDaemonRestart(
      { provider: "ollama-local", model: "qwen3.6:35b" },
      { probeRuntimeModelStatus, runCaptureExImpl },
    );

    expect(result).toEqual({ kind: "warmed", ok: false, timedOut: false });
  });
});
