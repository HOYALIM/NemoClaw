// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runStatsAction } from "../../lib/actions/stats";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class SandboxStatsCommand extends NemoClawCommand {
  static id = "sandbox:stats";
  static strict = true;
  static summary = "Show usage metrics for one sandbox";
  static description = "Filter locally recorded NemoClaw metrics for one sandbox.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox stats alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStatsCommand);
    runStatsAction({ sandboxName: args.sandboxName });
  }
}
