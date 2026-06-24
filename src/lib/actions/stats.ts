// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  formatMetricSummary,
  getMetricsFile,
  readMetricEvents,
  resetMetricEvents,
  summarizeMetricEvents,
} from "../metrics";

export type StatsActionOptions = {
  reset?: boolean;
  sandboxName?: string;
};

export function runStatsAction({ reset = false, sandboxName }: StatsActionOptions = {}): void {
  if (sandboxName && reset) {
    console.error("  --reset is only supported on global stats.");
    console.error("  Usage: nemoclaw stats --reset");
    process.exitCode = 1;
    return;
  }

  const metricsFile = getMetricsFile();
  if (reset) {
    try {
      resetMetricEvents(metricsFile);
      console.log(`  Metrics reset: ${metricsFile}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to reset metrics: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  const summary = summarizeMetricEvents(readMetricEvents(metricsFile), sandboxName);
  console.log(formatMetricSummary(summary, metricsFile));
}
