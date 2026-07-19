// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import type { JsonObject } from "../../core/json-types";
import { redactForLog, redactSensitiveText } from "../../security/redact";
import {
  addOnboardMachineEventListener,
  type OnboardMachineEvent,
  sanitizeOnboardMachineEventMetadata,
} from "./events";

export const ONBOARD_JSONL_SCHEMA_VERSION = 1 as const;

export interface OnboardJsonlEvent {
  schemaVersion: typeof ONBOARD_JSONL_SCHEMA_VERSION;
  session: string | null;
  type: OnboardMachineEvent["type"];
  timestamp: string;
  payload: JsonObject;
}

type WriteJsonlLine = (line: string) => boolean | void;

function createStdoutJsonlTransport(disable: () => void): {
  close: () => void;
  writeLine: WriteJsonlLine;
} {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  let closeRequested = false;
  let pendingWrites = 0;
  const pendingWriteErrors = new Set<Error>();
  const removeErrorHandlerWhenIdle = () => {
    if (closeRequested && pendingWrites === 0 && pendingWriteErrors.size === 0) {
      stdout.off("error", onError);
    }
  };
  const onError = (error: Error) => {
    pendingWriteErrors.delete(error);
    disable();
    removeErrorHandlerWhenIdle();
  };
  stdout.on("error", onError);
  return {
    close: () => {
      closeRequested = true;
      removeErrorHandlerWhenIdle();
    },
    writeLine: (line) => {
      pendingWrites += 1;
      try {
        const accepted = write(line, (error) => {
          pendingWrites -= 1;
          if (error) {
            // Node reports an asynchronous stream write failure to this
            // callback before emitting the paired `error` event. Keep the
            // listener installed until that event is consumed.
            pendingWriteErrors.add(error);
            disable();
          }
          removeErrorHandlerWhenIdle();
        });
        if (!accepted) disable();
        return accepted;
      } catch {
        pendingWrites -= 1;
        disable();
        removeErrorHandlerWhenIdle();
        return false;
      }
    },
  };
}

export function toOnboardJsonlEvent(event: OnboardMachineEvent): OnboardJsonlEvent {
  const payload: JsonObject = {
    state: event.state,
    step: event.step,
    context: sanitizeOnboardMachineEventMetadata({ ...event.context }),
    error: redactSensitiveText(event.error),
    metadata: redactForLog(sanitizeOnboardMachineEventMetadata(event.metadata)) as JsonObject,
  };

  return {
    schemaVersion: ONBOARD_JSONL_SCHEMA_VERSION,
    session: event.sessionId,
    type: event.type,
    timestamp: event.occurredAt,
    payload,
  };
}

export function observeOnboardJsonlEvents(requestedWriteLine?: WriteJsonlLine): () => void {
  let active = true;
  let closeTransport: () => void = () => {};
  let removeListener: () => void = () => {};
  const disable = () => {
    if (!active) return;
    active = false;
    removeListener();
    closeTransport();
  };
  const transport = requestedWriteLine
    ? { close: closeTransport, writeLine: requestedWriteLine }
    : createStdoutJsonlTransport(disable);
  closeTransport = transport.close;
  removeListener = addOnboardMachineEventListener((event) => {
    if (!active) return;
    try {
      if (transport.writeLine(`${JSON.stringify(toOnboardJsonlEvent(event))}\n`) === false) {
        disable();
      }
    } catch {
      // Observation is best-effort. Disable the failed transport without
      // changing canonical onboarding state or control flow.
      disable();
    }
  });

  return disable;
}

export async function withOnboardJsonlEventStream<T>(
  runOnboard: () => Promise<T>,
  writeLine?: WriteJsonlLine,
): Promise<T> {
  const stopObserving = observeOnboardJsonlEvents(writeLine);
  try {
    return await withStdoutRedirectedToStderr(runOnboard);
  } finally {
    stopObserving();
  }
}
