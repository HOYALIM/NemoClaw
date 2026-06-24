// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureConfigDir } from "./state/config-io";

export type MetricEventName =
  | "onboard_start"
  | "onboard_complete"
  | "sandbox_connect"
  | "sandbox_destroy"
  | "policy_apply";

export type MetricStatus = "success" | "failed";

const METRIC_EVENT_NAMES = new Set<string>([
  "onboard_start",
  "onboard_complete",
  "sandbox_connect",
  "sandbox_destroy",
  "policy_apply",
]);

const METRIC_STATUSES = new Set<string>(["success", "failed"]);

export interface MetricEvent {
  time: string;
  event: MetricEventName;
  sandbox?: string;
  command?: string;
  status?: MetricStatus;
  data?: Record<string, string | number | boolean | null>;
}

export interface MetricReadResult {
  events: MetricEvent[];
  invalidLines: number;
}

export interface MetricSummary {
  events: MetricEvent[];
  totalEvents: number;
  invalidLines: number;
  firstEventTime: string | null;
  lastEventTime: string | null;
  eventCounts: Record<string, number>;
  sandboxCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  sandbox?: string;
}

/**
 * Resolve the local JSONL metrics file for the current user.
 *
 * Metrics are intentionally local-only and live beside other NemoClaw user
 * state so operators can inspect or delete them without contacting a service.
 */
export function getMetricsFile(home = process.env.HOME || os.homedir()): string {
  return path.join(home || "/tmp", ".nemoclaw", "metrics.jsonl");
}

function isMetricEvent(value: unknown): value is MetricEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MetricEvent>;
  if (typeof candidate.time !== "string" || typeof candidate.event !== "string") {
    return false;
  }
  if (!METRIC_EVENT_NAMES.has(candidate.event)) {
    return false;
  }
  if (
    candidate.status !== undefined &&
    (typeof candidate.status !== "string" || !METRIC_STATUSES.has(candidate.status))
  ) {
    return false;
  }
  return true;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function ensureOwnerOnlyMetricsFile(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Metrics are best-effort; command execution should not fail on chmod.
  }
}

/**
 * Append one timestamped metric event to the local metrics stream.
 *
 * Returns false when metrics cannot be written so callers can keep their
 * primary CLI behavior best-effort and non-blocking.
 */
export function recordMetricEvent(
  event: MetricEventName,
  options: Omit<Partial<MetricEvent>, "event" | "time"> = {},
): boolean {
  const entry: MetricEvent = {
    time: new Date().toISOString(),
    event,
    ...options,
  };

  try {
    const filePath = getMetricsFile();
    ensureConfigDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    ensureOwnerOnlyMetricsFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read metric events from JSONL, preserving malformed-line counts.
 *
 * A corrupt metrics file should not break `nemoclaw stats`; invalid lines are
 * counted and skipped so operators can still inspect valid history.
 */
export function readMetricEvents(filePath = getMetricsFile()): MetricReadResult {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { events: [], invalidLines: 0 };
  }

  const events: MetricEvent[] = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isMetricEvent(parsed)) {
        events.push(parsed);
      } else {
        invalidLines++;
      }
    } catch {
      invalidLines++;
    }
  }
  return { events, invalidLines };
}

/**
 * Clear the local metrics stream while preserving the metrics file location.
 */
export function resetMetricEvents(filePath = getMetricsFile()): void {
  ensureConfigDir(path.dirname(filePath));
  fs.writeFileSync(filePath, "", { mode: 0o600 });
  ensureOwnerOnlyMetricsFile(filePath);
}

/**
 * Aggregate raw metric events into counts used by the CLI stats view.
 *
 * When a sandbox name is supplied, only matching sandbox-scoped events are
 * included while the malformed-line count remains global to the source file.
 */
export function summarizeMetricEvents(
  readResult: MetricReadResult,
  sandbox?: string,
): MetricSummary {
  const events = sandbox
    ? readResult.events.filter((event) => event.sandbox === sandbox)
    : [...readResult.events];
  const eventCounts: Record<string, number> = {};
  const sandboxCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};

  for (const event of events) {
    increment(eventCounts, event.event);
    if (event.sandbox) increment(sandboxCounts, event.sandbox);
    if (event.status) increment(statusCounts, event.status);
  }

  return {
    events,
    totalEvents: events.length,
    invalidLines: readResult.invalidLines,
    firstEventTime: events[0]?.time ?? null,
    lastEventTime: events.at(-1)?.time ?? null,
    eventCounts,
    sandboxCounts,
    statusCounts,
    sandbox,
  };
}

function formatCounts(counts: Record<string, number>, emptyLabel: string): string[] {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [`    ${emptyLabel}`];
  return entries.map(([key, count]) => `    ${key.padEnd(24)} ${count}`);
}

function displayPath(filePath: string): string {
  const home = process.env.HOME || os.homedir();
  const relative = path.relative(home, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join("~", relative);
  }
  return filePath;
}

/**
 * Render a human-readable CLI report for aggregated metric events.
 */
export function formatMetricSummary(summary: MetricSummary, filePath = getMetricsFile()): string {
  const lines: string[] = [];
  const title = summary.sandbox
    ? `NemoClaw stats for sandbox '${summary.sandbox}'`
    : "NemoClaw stats";

  lines.push("");
  lines.push(`  ${title}`);
  lines.push(`    Source: ${displayPath(filePath)}`);

  if (summary.totalEvents === 0) {
    lines.push(
      summary.sandbox
        ? `    No metrics recorded for sandbox '${summary.sandbox}'.`
        : "    No metrics recorded yet.",
    );
    if (summary.invalidLines > 0) {
      lines.push(`    Ignored malformed lines: ${summary.invalidLines}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`    Events: ${summary.totalEvents}`);
  lines.push(`    First:  ${summary.firstEventTime ?? "unknown"}`);
  lines.push(`    Last:   ${summary.lastEventTime ?? "unknown"}`);
  if (summary.invalidLines > 0) {
    lines.push(`    Ignored malformed lines: ${summary.invalidLines}`);
  }

  lines.push("");
  lines.push("  Events by type:");
  lines.push(...formatCounts(summary.eventCounts, "none"));

  lines.push("");
  lines.push("  Events by status:");
  lines.push(...formatCounts(summary.statusCounts, "none"));

  if (!summary.sandbox) {
    lines.push("");
    lines.push("  Sandbox activity:");
    lines.push(...formatCounts(summary.sandboxCounts, "none"));
  }

  lines.push("");
  return lines.join("\n");
}
