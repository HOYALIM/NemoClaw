// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CurlProbeResult } from "../adapters/http/probe";
import { getCurlTimingArgs, runCurlProbe } from "../adapters/http/probe";
import type { ModelCatalogFetchResult, ModelValidationResult } from "../onboard/types";
import { isSafeModelId } from "../validation";
import { CLOUD_MODEL_OPTIONS, DEFAULT_CLOUD_MODEL } from "./config";

// credentials.ts still uses CommonJS-style exports.
const { normalizeCredentialValue } = require("../credentials/store");

export const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
// GLM 5.1 retirement contract (#6069): the external featured feed may lag an
// NVIDIA Endpoints retirement. The repository authority is CLOUD_MODEL_OPTIONS
// plus the provider-boundary assertion in test/inference-options-docs.test.ts,
// which retain GLM 5.1 only for Hermes. Keep this policy deny-list until a
// deliberate product change reverses #6069; a transient feed omission alone is
// not a removal signal.
const RETIRED_NVIDIA_FEATURED_MODEL_IDS = new Set(["z-ai/glm-5.1"]);
const MAX_NVIDIA_FEATURED_CATALOG_BYTES = 1024 * 1024;
const MAX_NVIDIA_FEATURED_MODELS = 100;
const MAX_NVIDIA_FEATURED_MODEL_ID_LENGTH = 256;
const MAX_NVIDIA_FEATURED_MODEL_LABEL_LENGTH = 160;
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
const UNSAFE_TERMINAL_TEXT_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  buildEndpointUrl?: string;
  featuredModelsUrl?: string;
  /** When "query-param", send the API key as a ?key= URL parameter instead of
   *  an Authorization: Bearer header. Required for Google Gemini which rejects
   *  requests carrying both auth methods. See issue #1960. */
  authMode?: "bearer" | "query-param";
  warn?: (message: string) => void;
}

type ModelCatalogItem = {
  id?: string | null;
  name?: string | null;
};

type ModelCatalogResponse = {
  data?: Array<ModelCatalogItem | null>;
};

type FeaturedModelCatalogItem = {
  model?: string | null;
  "model-name"?: string | null;
};

type FeaturedModelCatalogResponse = {
  "featured-models"?: Array<FeaturedModelCatalogItem | null>;
};

export type FeaturedModelOption = {
  id: string;
  label: string;
};

export type FeaturedModelFetchResult =
  | {
      ok: true;
      models: FeaturedModelOption[];
    }
  | {
      ok: false;
      message: string;
      httpStatus: number;
      curlStatus: number;
    };

/**
 * Parses a provider catalog response body as JSON.
 */
function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

/**
 * Extracts safe string model IDs from an OpenAI-compatible catalog response.
 */
function parseModelIds(body: string, itemKeys: Array<keyof ModelCatalogItem> = ["id"]): string[] {
  const parsed = parseJson<ModelCatalogResponse>(body);
  if (!Array.isArray(parsed.data)) {
    throw new Error("Unexpected model catalog response: expected a top-level data array");
  }
  return parsed.data
    .map((item) => {
      if (!item) return null;
      for (const key of itemKeys) {
        const value = item[key];
        if (typeof value === "string" && value) {
          return value;
        }
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

/**
 * Normalizes the NVIDIA featured-models catalog IDs into endpoint model IDs.
 */
function normalizeFeaturedModelId(model: string): string {
  const trimmed = model.trim();
  // Minimax rollout contract (#5827): the external feed has emitted the stale
  // M2.7 ID/label while CLOUD_MODEL_OPTIONS and the task-fit docs define M3 as
  // the NVIDIA Endpoints choice. This is an upstream-lag bridge; remove this ID
  // rewrite together with the label rewrite and fixture only once the feed no
  // longer emits M2.7 and publishes M3 directly.
  if (trimmed === "minimaxai/minimax-m2.7") {
    return "minimaxai/minimax-m3";
  }
  // Nemotron namespace contract (#5827): the external feed has emitted bare
  // nemotron-3-* IDs, while CLOUD_MODEL_OPTIONS and the matching OpenClaw
  // model-specific setup manifest use the canonical nvidia/ endpoint namespace.
  // The feed can lag that repository contract; remove this bridge and its
  // bare-ID fixture only once affected entries no longer emit bare IDs and use
  // the namespaced form.
  if (/^nemotron-3-/i.test(trimmed)) {
    return `nvidia/${trimmed}`;
  }
  return trimmed;
}

function sanitizeFeaturedCatalogText(value: string, maxLength: number): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(UNSAFE_TERMINAL_TEXT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Normalizes NVIDIA featured-model labels for known catalog lag cases.
 */
function normalizeFeaturedModelLabel(id: string, label: string): string {
  const sanitized = sanitizeFeaturedCatalogText(label, MAX_NVIDIA_FEATURED_MODEL_LABEL_LENGTH);
  // Keep the display label coupled to the Minimax rollout contract above.
  if (id === "minimaxai/minimax-m3" && /^minimax m2\.7$/i.test(sanitized)) {
    return "Minimax M3";
  }
  return sanitized;
}

/**
 * Parses NVIDIA's featured-models catalog into safe onboarding menu options.
 */
export function parseNvidiaFeaturedModels(body: string): FeaturedModelOption[] {
  if (Buffer.byteLength(body, "utf8") > MAX_NVIDIA_FEATURED_CATALOG_BYTES) {
    throw new Error("Unexpected featured model catalog response: body exceeds 1 MiB");
  }
  const parsed = parseJson<FeaturedModelCatalogResponse>(body);
  const featuredModels = parsed["featured-models"];
  if (!Array.isArray(featuredModels)) {
    throw new Error('Unexpected featured model catalog response: expected "featured-models" array');
  }

  const models: FeaturedModelOption[] = [];
  const seenIds = new Set<string>();
  for (const item of featuredModels) {
    const id = typeof item?.model === "string" ? normalizeFeaturedModelId(item.model) : "";
    const idKey = id.toLowerCase();
    const label =
      typeof item?.["model-name"] === "string"
        ? normalizeFeaturedModelLabel(id, item["model-name"])
        : "";
    if (
      !id ||
      id.length > MAX_NVIDIA_FEATURED_MODEL_ID_LENGTH ||
      !label ||
      !isSafeModelId(id) ||
      RETIRED_NVIDIA_FEATURED_MODEL_IDS.has(idKey) ||
      seenIds.has(idKey)
    ) {
      continue;
    }
    models.push({ id, label });
    seenIds.add(idKey);
    if (models.length >= MAX_NVIDIA_FEATURED_MODELS) break;
  }
  return models;
}

/**
 * Fetches NVIDIA's public featured-models catalog without requiring credentials.
 */
export function fetchNvidiaFeaturedModels(
  options: ProviderModelOptions = {},
): FeaturedModelFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const sourceUrl = options.featuredModelsUrl ?? NVIDIA_FEATURED_MODELS_URL;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      sourceUrl,
    ]);
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
      };
    }
    try {
      return { ok: true, models: parseNvidiaFeaturedModels(result.body) };
    } catch (error) {
      return {
        ok: false,
        httpStatus: result.httpStatus,
        curlStatus: result.curlStatus,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Returns live featured NVIDIA models, falling back to the curated snapshot.
 */
export function getNvidiaFeaturedModelOptions(
  options: ProviderModelOptions = {},
): FeaturedModelOption[] {
  const result = fetchNvidiaFeaturedModels(options);
  if (result.ok && result.models.length > 0) {
    return result.models;
  }
  const detail = result.ok
    ? "catalog returned no safe model IDs"
    : `${sanitizeFeaturedCatalogText(result.message, 200) || "catalog request failed without details"}${result.httpStatus > 0 ? `; HTTP ${result.httpStatus}` : ""}`;
  (options.warn ?? console.warn)(
    `  Warning: failed to load NVIDIA's featured model catalog; falling back to the bundled list (${detail}).`,
  );
  return CLOUD_MODEL_OPTIONS;
}

function buildNvidiaFeaturedModelPromptOptions(
  defaultModelId: string | null | undefined,
  cloudModelOptions: FeaturedModelOption[],
): {
  defaultModelId: string;
  cloudModelOptions: FeaturedModelOption[];
} {
  const preferredDefault = defaultModelId || DEFAULT_CLOUD_MODEL;
  const effectiveDefault = cloudModelOptions.some((option) => option.id === preferredDefault)
    ? preferredDefault
    : (cloudModelOptions[0]?.id ?? preferredDefault);
  return { defaultModelId: effectiveDefault, cloudModelOptions };
}

/**
 * Builds NVIDIA Endpoints prompt options from the featured-models catalog.
 */
export function getNvidiaFeaturedModelPromptOptions(
  defaultModelId?: string | null,
  options: ProviderModelOptions = {},
): {
  defaultModelId: string;
  cloudModelOptions: FeaturedModelOption[];
} {
  return buildNvidiaFeaturedModelPromptOptions(
    defaultModelId,
    getNvidiaFeaturedModelOptions(options),
  );
}

/**
 * Caches one featured-model catalog lookup for a single onboarding session.
 */
export function createNvidiaFeaturedModelPromptOptionsLoader(
  options: ProviderModelOptions = {},
): (defaultModelId?: string | null) => ReturnType<typeof getNvidiaFeaturedModelPromptOptions> {
  let cachedModels: FeaturedModelOption[] | null = null;
  return (defaultModelId?: string | null) => {
    cachedModels ??= getNvidiaFeaturedModelOptions(options);
    return buildNvidiaFeaturedModelPromptOptions(defaultModelId, cachedModels);
  };
}

/**
 * Converts a curl probe result into NemoClaw's model catalog result shape.
 */
function toModelCatalogFetchResult(
  result: CurlProbeResult,
  itemKeys: Array<keyof ModelCatalogItem> = ["id"],
): ModelCatalogFetchResult {
  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
    };
  }

  try {
    return { ok: true, ids: parseModelIds(result.body, itemKeys) };
  } catch (error) {
    return {
      ok: false,
      httpStatus: result.httpStatus,
      curlStatus: result.curlStatus,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches available NVIDIA Endpoint model IDs using the provided API key.
 */
export function fetchNvidiaEndpointModels(
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${normalizeCredentialValue(apiKey)}`,
      `${buildEndpointUrl}/models`,
    ]);
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validates that a selected model appears in the NVIDIA Endpoints catalog.
 */
export function validateNvidiaEndpointModel(
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const buildEndpointUrl = options.buildEndpointUrl ?? BUILD_ENDPOINT_URL;
  const available = fetchNvidiaEndpointModels(apiKey, options);
  if (!available.ok) {
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${buildEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from NVIDIA Endpoints. Checked ${buildEndpointUrl}/models.`,
  };
}

/**
 * Fetches model IDs from an OpenAI-compatible `/models` endpoint.
 */
export function fetchOpenAiLikeModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  const useQueryParam = options.authMode === "query-param";
  const normalizedKey = apiKey ? normalizeCredentialValue(apiKey) : "";
  const baseUrl = `${String(endpointUrl).replace(/\/+$/, "")}/models`;
  const url =
    useQueryParam && normalizedKey
      ? `${baseUrl}?key=${encodeURIComponent(normalizedKey)}`
      : baseUrl;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      ...(!useQueryParam && normalizedKey ? ["-H", `Authorization: Bearer ${normalizedKey}`] : []),
      url,
    ]);
    return toModelCatalogFetchResult(result);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches Anthropic-compatible model IDs from a Messages API provider.
 */
export function fetchAnthropicModels(
  endpointUrl: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelCatalogFetchResult {
  const runCurlProbeImpl = options.runCurlProbeImpl ?? runCurlProbe;
  try {
    const result = runCurlProbeImpl([
      "-sS",
      ...getCurlTimingArgs(),
      "-H",
      `x-api-key: ${normalizeCredentialValue(apiKey)}`,
      "-H",
      "anthropic-version: 2023-06-01",
      `${String(endpointUrl).replace(/\/+$/, "")}/v1/models`,
    ]);
    return toModelCatalogFetchResult(result, ["id", "name"]);
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validates a selected model against an Anthropic-compatible provider catalog.
 */
export function validateAnthropicModel(
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchAnthropicModels(normalizedEndpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.httpStatus === 404 || available.httpStatus === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${normalizedEndpointUrl}/v1/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from Anthropic. Checked ${normalizedEndpointUrl}/v1/models.`,
  };
}

/**
 * Validates a selected model against an OpenAI-compatible provider catalog.
 */
export function validateOpenAiLikeModel(
  label: string,
  endpointUrl: string,
  model: string,
  apiKey: string,
  options: ProviderModelOptions = {},
): ModelValidationResult {
  const normalizedEndpointUrl = String(endpointUrl).replace(/\/+$/, "");
  const available = fetchOpenAiLikeModels(normalizedEndpointUrl, apiKey, options);
  if (!available.ok) {
    if (available.httpStatus === 404 || available.httpStatus === 405) {
      return { ok: true, validated: false };
    }
    return {
      ok: false,
      httpStatus: available.httpStatus,
      curlStatus: available.curlStatus,
      message: `Could not validate model against ${normalizedEndpointUrl}/models: ${available.message}`,
    };
  }
  if (available.ids.includes(model)) {
    return { ok: true, validated: true };
  }
  return {
    ok: false,
    httpStatus: 200,
    curlStatus: 0,
    message: `Model '${model}' is not available from ${label}. Checked ${normalizedEndpointUrl}/models.`,
  };
}
