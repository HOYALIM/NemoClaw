// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export interface NemoClawRefFidelityEvidence {
  expectedRef: string;
  actualRef: string;
  cliPath: string;
  source: "workflow-checkout";
}

export function verifyNemoClawRefFidelity({
  expectedRef,
  actualRef,
  cliPath,
  expectedCliPath,
}: {
  expectedRef?: string;
  actualRef: string;
  cliPath: string;
  expectedCliPath: string;
}): NemoClawRefFidelityEvidence {
  if (!expectedRef || !COMMIT_SHA.test(expectedRef)) {
    throw new Error(
      `NEMOCLAW_TUI_EXPECTED_CHECKOUT_SHA must be a lowercase 40-character SHA; received ${expectedRef || "<empty>"}`,
    );
  }
  if (!COMMIT_SHA.test(actualRef)) {
    throw new Error(
      `tested NemoClaw checkout did not report a valid commit SHA: ${actualRef || "<empty>"}`,
    );
  }
  if (resolve(cliPath) !== resolve(expectedCliPath)) {
    throw new Error(
      `TUI harness CLI does not come from the tested checkout: expected ${resolve(expectedCliPath)}, received ${resolve(cliPath)}`,
    );
  }
  if (actualRef !== expectedRef) {
    throw new Error(`tested NemoClaw ref mismatch: expected ${expectedRef}, received ${actualRef}`);
  }

  return {
    expectedRef,
    actualRef,
    cliPath: resolve(cliPath),
    source: "workflow-checkout",
  };
}
