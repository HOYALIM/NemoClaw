// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import { runStatsAction } from "../lib/actions/stats";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class StatsCommand extends NemoClawCommand {
  static id = "stats";
  static strict = true;
  static summary = "Show local usage metrics";
  static description = "Show locally recorded NemoClaw lifecycle and sandbox activity metrics.";
  static usage = ["stats [--reset]"];
  static examples = ["<%= config.bin %> stats", "<%= config.bin %> stats --reset"];
  static flags = {
    reset: Flags.boolean({
      description: "Clear locally recorded metrics",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(StatsCommand);
    runStatsAction({ reset: flags.reset === true });
  }
}
