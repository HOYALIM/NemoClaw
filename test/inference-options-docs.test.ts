// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TypeScript;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inferenceOptionsPath = path.join(repoRoot, "docs", "inference", "inference-options.mdx");
const inferenceConfigPath = path.join(repoRoot, "src", "lib", "inference", "config.ts");

function sectionBetween(markdown: string, heading: string, nextHeading: string): string {
  const start = markdown.indexOf(heading);
  const end = markdown.indexOf(nextHeading, start + heading.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

function unwrapConstAssertion(expression: TypeScript.Expression): TypeScript.Expression {
  return ts.isAsExpression(expression) ? unwrapConstAssertion(expression.expression) : expression;
}

function readCuratedCloudModelIds(): string[] {
  const source = fs.readFileSync(inferenceConfigPath, "utf8");
  const sourceFile = ts.createSourceFile(
    inferenceConfigPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported || !ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(sourceFile) !== "CLOUD_MODEL_OPTIONS") continue;
      const initializer = declaration.initializer && unwrapConstAssertion(declaration.initializer);
      expect(initializer && ts.isArrayLiteralExpression(initializer)).toBe(true);

      return (initializer as TypeScript.ArrayLiteralExpression).elements.map((element) => {
        expect(ts.isObjectLiteralExpression(element)).toBe(true);
        const idProperty = (element as TypeScript.ObjectLiteralExpression).properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(sourceFile) === "id" &&
            ts.isStringLiteralLike(unwrapConstAssertion(property.initializer)),
        );
        expect(idProperty).toBeTruthy();
        const idInitializer = unwrapConstAssertion(
          (idProperty as TypeScript.PropertyAssignment).initializer,
        );
        return (idInitializer as TypeScript.StringLiteral).text;
      });
    }
  }

  throw new Error("CLOUD_MODEL_OPTIONS export was not found");
}

describe("inference options model task-fit docs (#4755)", () => {
  it("keeps a per-model task-fit comparison table for curated onboarding models", () => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const section = sectionBetween(
      markdown,
      "## Model Task-Fit Guide",
      "## Choosing the Right Option for Nemotron",
    );

    expect(section).toContain(
      "| Model | Best-for task type | Relative latency | Tool-use quality | Context-window fit | Relative cost |",
    );
    expect(section).toContain("provider catalog remains authoritative");
    expect(section).not.toMatch(/\bTBD\b|\bTODO\b/i);

    const expectedModelIds = [
      ...readCuratedCloudModelIds(),
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro-2026-03-05",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ];

    for (const modelId of expectedModelIds) {
      expect(section).toContain(`| \`${modelId}\` |`);
    }
  });
});
