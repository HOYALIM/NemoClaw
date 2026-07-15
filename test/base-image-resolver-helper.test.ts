// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const helper = path.join(repoRoot, ".github/actions/base-image-resolver.sh");
const tempDirs: string[] = [];

function run(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", `source "$HELPER"\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, HELPER: helper, ...env },
  });
}

function fakeDocker(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-resolver-"));
  tempDirs.push(dir);
  const executable = path.join(dir, "docker");
  writeFileSync(executable, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("base image resolver helper", () => {
  it("pulls a remote image and accepts a compatible glibc version", () => {
    const bin = fakeDocker(`
if [[ "$1" == pull ]]; then exit 0; fi
if [[ "$1" == run ]]; then echo "ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39"; exit 0; fi
exit 1`);

    const result = run(
      'resolver_pull example:test && version="$(resolver_glibc_version example:test)" && resolver_glibc_ok "$version" 2.39 && printf "%s" "$version"',
      { PATH: `${bin}:${process.env.PATH}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2.39");
  });

  it("rejects an incompatible or missing glibc version", () => {
    expect(run('resolver_glibc_ok "2.38" 2.39').status).not.toBe(0);
    expect(run('resolver_glibc_ok "" 2.39').status).not.toBe(0);
  });

  it("returns only the requested repository digest", () => {
    const bin = fakeDocker(`
cat <<'EOF'
other.example/base@sha256:aaaaaaaa
ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:bbbbbbbb
EOF`);
    const env = { PATH: `${bin}:${process.env.PATH}` };

    const found = run(
      "resolver_repo_digest mutable:tag ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      env,
    );
    const missing = run("resolver_repo_digest mutable:tag ghcr.io/nvidia/nemoclaw/missing", env);

    expect(found.status).toBe(0);
    expect(found.stdout.trim()).toBe("ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:bbbbbbbb");
    expect(missing.status).not.toBe(0);
  });

  it("iterates candidates through an agent-owned validator and reports exhaustion", () => {
    const selected = run(`
validate() { [[ "$1" == compatible ]] && printf '%s' "$1"; }
resolver_try_candidates validate rejected compatible later`);
    const exhausted = run(`
reject() { return 1; }
resolver_try_candidates reject first second`);

    expect(selected.status).toBe(0);
    expect(selected.stdout).toBe("compatible");
    expect(exhausted.status).not.toBe(0);
  });

  it("builds a local fallback with the exact Dockerfile and tag", () => {
    const bin = fakeDocker('printf "%s\\n" "$*" >> "$DOCKER_LOG"');
    const log = path.join(bin, "docker.log");

    const result = run("resolver_build_local agents/hermes/Dockerfile.base local:test", {
      DOCKER_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      "build -f agents/hermes/Dockerfile.base -t local:test .\n",
    );
  });

  it("writes one validated GitHub environment assignment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-env-"));
    tempDirs.push(dir);
    const githubEnv = path.join(dir, "github.env");

    const valid = run("resolver_write_env BASE_IMAGE ghcr.io/nvidia/nemoclaw/sandbox-base:latest", {
      GITHUB_ENV: githubEnv,
    });
    const invalid = run('resolver_write_env "BAD-NAME" image', { GITHUB_ENV: githubEnv });

    expect(valid.status).toBe(0);
    expect(invalid.status).not.toBe(0);
    expect(readFileSync(githubEnv, "utf8")).toBe(
      "BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest\n",
    );
  });
});
