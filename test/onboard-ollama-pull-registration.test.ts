// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE =
  '{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}';

/**
 * Writes a fake curl binary that mimics successful Ollama proxy probes.
 */
function writeAlwaysOkCurl(fakeBin: string, body = OLLAMA_CHAT_COMPLETIONS_TOOL_CALL_RESPONSE) {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
body='${body}'
status="200"
outfile=""
url=""
has_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config) has_config=1; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ "$has_config" -eq 0 ] && [[ "$url" == *:11435/* ]]; then
  status="401"
fi
if [ -n "$outfile" ]; then
  printf '%s' "$body" > "$outfile"
fi
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
}

function writeAlwaysOkOllama(fakeBin: string, pullLog: string) {
  fs.writeFileSync(
    path.join(fakeBin, "ollama"),
    `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then
  echo "$2" >> ${JSON.stringify(pullLog)}
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
}

describe("Ollama onboarding pull registration", { timeout: testTimeout(60_000) }, () => {
  it("offers starter Ollama models and verifies discovery after pulling the selected model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-bootstrap-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-bootstrap-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin);
    writeAlwaysOkOllama(fakeBin, pullLog);

    const script = String.raw`
const fs = require("fs");
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1", "y"];
const messages = [];
const pullLog = ${JSON.stringify(pullLog)};
const listChecks = [];

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) {
    const afterPull = fs.existsSync(pullLog);
    listChecks.push(afterPull ? "after-pull" : "before-pull");
    return afterPull ? "qwen3.5:9b  abc  6 GB  now" : "";
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines, listChecks }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "qwen3.5:9b");
    assert.ok(payload.lines.some((line: string) => line.includes("Ollama starter models:")));
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("No local Ollama models are installed yet"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Pulling Ollama model: qwen3.5:9b")),
    );
    assert.ok(
      payload.listChecks.includes("after-pull"),
      "expected onboarding to verify Ollama model discovery after the pull completed",
    );
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b");
  });

  it("reprompts when a pulled Ollama model never appears in discovery", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-register-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-register-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const pullLog = path.join(tmpDir, "pulls.log");

    fs.mkdirSync(fakeBin, { recursive: true });
    writeAlwaysOkCurl(fakeBin);
    writeAlwaysOkOllama(fakeBin, pullLog);

    const script = String.raw`
const fs = require("fs");
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const answers = ["7", "1", "y", "2", "llama3.2:3b", "y"];
const messages = [];
const pullLog = ${JSON.stringify(pullLog)};

credentials.prompt = async (message) => {
  messages.push(message);
  return answers.shift() || "";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return JSON.stringify({ models: [] });
  if (cmd.includes("ollama list")) {
    return fs.existsSync(pullLog) && fs.readFileSync(pullLog, "utf8").includes("llama3.2:3b")
      ? "llama3.2:3b  def  2 GB  now"
      : "";
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("-o args=")) return "node ollama-auth-proxy.js";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null);
    originalLog(JSON.stringify({ result, messages, lines }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_TEST_NO_SLEEP: "1",
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "ollama-local");
    assert.equal(payload.result.model, "llama3.2:3b");
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Ollama pull for 'qwen3.5:9b' completed, but Ollama did not list"),
      ),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Choose a different Ollama model or select Other."),
      ),
    );
    assert.equal(fs.readFileSync(pullLog, "utf8").trim(), "qwen3.5:9b\nllama3.2:3b");
  });
});
