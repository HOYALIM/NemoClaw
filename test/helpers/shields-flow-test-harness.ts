// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";

const shieldsModulePath = "./index.js";

export type ShieldsFlowHarness = {
  auditSpy: MockInstance;
  errorSpy: MockInstance;
  getOpenClawPosture: () => "locked" | "mutable";
  logSpy: MockInstance;
  runCaptureSpy: MockInstance;
  runSpy: MockInstance;
  shieldsDown: typeof import("../../src/lib/shields/index.js").shieldsDown;
  shieldsStatus: typeof import("../../src/lib/shields/index.js").shieldsStatus;
  shieldsUp: typeof import("../../src/lib/shields/index.js").shieldsUp;
  isShieldsDown: typeof import("../../src/lib/shields/index.js").isShieldsDown;
  synchronizeAutoRestoreWithShieldsDown: typeof import("../../src/lib/shields/index.js").synchronizeAutoRestoreWithShieldsDown;
};

export type ShieldsFlowHarnessOptions = {
  beginContainment?: typeof import("../../src/lib/state/mcp-lifecycle-lock.js").beginCommittedMcpLifecycleContainmentSync;
  confirmOpenClawInodeFlags?: boolean;
  directSandboxUnavailable?: boolean;
  dockerExecFileSync?: (argv: unknown) => string;
  failOpenClawGuardActions?: Array<"lock" | "unlock">;
  initialOpenClawPosture?: "locked" | "mutable";
  invokedAs?: "nemoclaw" | "nemohermes";
  openClawGuardFailure?: {
    code: string;
    path: string;
    detail: string;
  };
  openClawGuardFailures?: Array<{
    code: string;
    path: string;
    detail: string;
  }>;
  fork?: (...args: unknown[]) => {
    pid: number;
    disconnect: () => void;
    unref: () => void;
    send: () => boolean;
    kill: () => boolean;
  };
  livePolicyYaml?: string;
  run?: (cmd: unknown) => { status: number };
  timerAuthorityRevokedSequence?: readonly boolean[];
};

function throwHarnessError(error: Error): never {
  throw error;
}

export function createShieldsFlowHarness(
  requireDist: NodeRequire,
  tmpDir: string,
  options: ShieldsFlowHarnessOptions = {},
): ShieldsFlowHarness {
  vi.stubEnv("NEMOCLAW_INVOKED_AS", options.invokedAs ?? "nemoclaw");
  delete require.cache[requireDist.resolve(shieldsModulePath)];
  delete require.cache[requireDist.resolve("./timer-bound-lock.js")];
  delete require.cache[requireDist.resolve("./transition-lock.js")];
  delete require.cache[requireDist.resolve("../sandbox/privileged-exec.js")];
  delete require.cache[requireDist.resolve("../cli/branding.js")];
  const lifecycleLock = requireDist(
    "../state/mcp-lifecycle-lock.js",
  ) as typeof import("../../src/lib/state/mcp-lifecycle-lock.js");
  const beginContainment =
    options.beginContainment ?? lifecycleLock.beginCommittedMcpLifecycleContainmentSync;
  vi.spyOn(lifecycleLock, "beginCommittedMcpLifecycleContainmentSync").mockImplementation(
    beginContainment,
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const runner = requireDist("../runner.js");
  const policy = requireDist("../policy/index.js");
  const agentConfig = requireDist("../sandbox/agent-config.js");
  const registry = requireDist("../state/registry.js");
  const privilegedExec = requireDist("../sandbox/privileged-exec.js");
  const dockerExec = requireDist("../adapters/docker/exec.js");
  const audit = requireDist("./audit.js");
  const timerControl = requireDist("./timer-control.js");
  const childProcess = requireDist("node:child_process");
  let openClawPosture: "locked" | "mutable" = options.initialOpenClawPosture ?? "mutable";

  vi.spyOn(runner, "validateName").mockImplementation((name: unknown) => String(name));
  const runCaptureSpy = vi
    .spyOn(runner, "runCapture")
    .mockReturnValue(options.livePolicyYaml ?? "version: 1\nnetwork_policies:\n  test: {}\n");
  const runSpy = vi.spyOn(runner, "run").mockImplementation((cmd: unknown) => {
    return options.run ? options.run(cmd) : { status: 0 };
  });
  options.fork && vi.spyOn(childProcess, "fork").mockImplementation(options.fork);
  vi.spyOn(policy, "buildPolicyGetCommand").mockReturnValue(["openshell", "policy", "get"]);
  vi.spyOn(policy, "buildPolicySetCommand").mockReturnValue(["openshell", "policy", "set"]);
  vi.spyOn(policy, "parseCurrentPolicy").mockImplementation((raw: unknown) => String(raw));
  vi.spyOn(policy, "resolvePermissivePolicyPath").mockReturnValue(
    path.join(tmpDir, "permissive.yaml"),
  );
  fs.writeFileSync(path.join(tmpDir, "permissive.yaml"), "version: 1\nnetwork_policies: {}\n");
  vi.spyOn(agentConfig, "resolveAgentConfig").mockReturnValue({
    agentName: "openclaw",
    configDir: "/sandbox/.openclaw",
    configFile: "openclaw.json",
    configPath: "/sandbox/.openclaw/openclaw.json",
    format: "json",
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "openclaw", openshellDriver: "docker" });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [{ name: "openclaw" }] });
  const directSandboxUnavailableError = new Error(
    "No running direct OpenShell sandbox container found for 'openclaw' (driver: docker). Expected a running container named openshell-openclaw or openshell-openclaw-*. Is the sandbox running?",
  );
  vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(
    Boolean(options.directSandboxUnavailable),
  );
  vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockImplementation(
    (_sandboxName: unknown, cmd: unknown) =>
      options.directSandboxUnavailable
        ? throwHarnessError(directSandboxUnavailableError)
        : [
            "exec",
            "--user",
            "root",
            "openshell-openclaw",
            ...(Array.isArray(cmd) ? cmd.map(String) : []),
          ],
  );
  vi.spyOn(dockerExec, "dockerSpawnSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const action = ["preflight", "lock", "unlock"].find((candidate) => args.includes(candidate));
    const openClawGuard = args.some((arg) => arg.endsWith("openclaw-config-guard.py"));
    const shouldFailOpenClawGuard = Boolean(
      openClawGuard &&
        (action === "lock" || action === "unlock") &&
        options.failOpenClawGuardActions?.includes(action),
    );
    const failures = options.openClawGuardFailures ?? [
      options.openClawGuardFailure ?? {
        code: "startup-not-ready",
        path: "/run/nemoclaw/openclaw-config-ready.json",
        detail: "OpenClaw startup is not ready for host config mutations",
      },
    ];
    const failureResult = {
      status: 1,
      signal: null,
      stdout: `${failures
        .map((failure) => JSON.stringify({ type: "issue", ...failure }))
        .join("\n")}\n${JSON.stringify({ type: "result", action, status: "failed" })}\n`,
      stderr: "",
      pid: 0,
      output: [],
    };
    openClawPosture = shouldFailOpenClawGuard
      ? openClawPosture
      : openClawGuard && action === "lock"
        ? "locked"
        : openClawGuard && action === "unlock"
          ? "mutable"
          : openClawPosture;
    const successResult = {
      status: 0,
      signal: null,
      stdout: action
        ? `${JSON.stringify({
            type: "result",
            action,
            status: "ok",
            ...(openClawGuard
              ? {
                  configDir: "/sandbox/.openclaw",
                  files: ["openclaw.json", ".config-hash"],
                  chattrApplied: action === "lock",
                }
              : { issueCount: 0 }),
          })}\n`
        : "",
      stderr: "",
      pid: 0,
      output: [],
    };
    return (shouldFailOpenClawGuard ? failureResult : successResult) as never;
  });
  vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((argv: unknown) => {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    return options.dockerExecFileSync
      ? options.dockerExecFileSync(argv)
      : args.includes("sha256sum")
        ? "a".repeat(64) + "  /sandbox/.openclaw/openclaw.json\n"
        : args.includes("lsattr") && options.confirmOpenClawInodeFlags
          ? `${openClawPosture === "locked" ? "----i---------e-----" : "----------------------"} ${String(args.at(-1))}\n`
          : args.includes("stat")
            ? args.at(-1) === "/sandbox"
              ? openClawPosture === "locked"
                ? "1775 root:sandbox\n"
                : "755 sandbox:sandbox\n"
              : args.at(-1) === "/sandbox/.openclaw"
                ? openClawPosture === "locked"
                  ? "755 root:root\n"
                  : "2770 sandbox:sandbox\n"
                : openClawPosture === "locked"
                  ? "444 root:root\n"
                  : "660 sandbox:sandbox\n"
            : "";
  });
  const auditSpy = vi.spyOn(audit, "appendAuditEntry").mockImplementation(() => undefined);
  if (options.timerAuthorityRevokedSequence) {
    const timerAuthorityRevocations = [...options.timerAuthorityRevokedSequence];
    const finalTimerAuthorityRevocation = timerAuthorityRevocations.at(-1) ?? true;
    vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
      const authorityRevoked = timerAuthorityRevocations.shift() ?? finalTimerAuthorityRevocation;
      return {
        authorityRevoked,
        markerFound: true,
        markerPid: 4242,
        wasAlive: false,
        terminated: false,
        warnings: authorityRevoked
          ? []
          : ["Failed to remove shields timer marker: permission denied"],
      };
    });
  }

  const shields = requireDist(shieldsModulePath);
  logSpy.mockClear();
  errorSpy.mockClear();
  auditSpy.mockClear();
  runCaptureSpy.mockClear();
  return {
    auditSpy,
    errorSpy,
    getOpenClawPosture: () => openClawPosture,
    logSpy,
    runCaptureSpy,
    runSpy,
    shieldsDown: shields.shieldsDown,
    shieldsStatus: shields.shieldsStatus,
    shieldsUp: shields.shieldsUp,
    isShieldsDown: shields.isShieldsDown,
    synchronizeAutoRestoreWithShieldsDown: shields.synchronizeAutoRestoreWithShieldsDown,
  };
}

export function expectStagedDriverNeutralRecovery(
  errorSpy: MockInstance,
  sandboxName: string,
  cliName = "nemoclaw",
): string {
  const output = errorSpy.mock.calls.flat().map(String).join("\n");
  expect(output).toContain(
    `Recovery: confirm the sandbox is running and ready, then retry \`${cliName} ${sandboxName} shields up\`.`,
  );
  expect(output).toContain(
    `If the retry still fails, rebuild a known-good baseline with \`${cliName} ${sandboxName} rebuild --yes\`.`,
  );
  expect(output).not.toMatch(/kubectl/i);
  return output;
}
