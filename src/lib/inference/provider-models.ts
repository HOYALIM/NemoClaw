// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLOUD_MODEL_OPTIONS, DEFAULT_CLOUD_MODEL } from "./config";
import type { CurlProbeResult } from "../adapters/http/probe";
import { getCurlTimingArgs, runCurlProbe } from "../adapters/http/probe";
import type { ModelCatalogFetchResult, ModelValidationResult } from "../onboard/types";
import { isSafeModelId } from "../validation";

// credentials.ts still uses CommonJS-style exports.
const { normalizeCredentialValue } = require("../credentials/store");

export const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";

export interface ProviderModelOptions {
  runCurlProbeImpl?: (argv: string[]) => CurlProbeResult;
  buildEndpointUrl?: string;
  featuredModelsUrl?: string;
  /** When "query-param", send the API key as a ?key= URL parameter instead of
   *  an Authorization: Bearer header. Required for Google Gemini which rejects
   *  requests carrying both auth methods. See issue #1960. */
  authMode?: "bearer" | "query-param";
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
  if (trimmed === "minimaxai/minimax-m2.7") {
    return "minimaxai/minimax-m3";
  }
  if (/^nemotron-3-/i.test(trimmed)) {
    return `nvidia/${trimmed}`;
  }
  return trimmed;
}

/**
 * Normalizes NVIDIA featured-model labels for known catalog lag cases.
 */
function normalizeFeaturedModelLabel(id: string, label: string): string {
  const trimmed = label.trim();
  if (id === "minimaxai/minimax-m3" && /^minimax m2\.7$/i.test(trimmed)) {
    return "Minimax M3";
  }
  return trimmed;
}

/**
 * Parses NVIDIA's featured-models catalog into safe onboarding menu options.
 */
export function parseNvidiaFeaturedModels(body: string): FeaturedModelOption[] {
  const parsed = parseJson<FeaturedModelCatalogResponse>(body);
  const featuredModels = parsed["featured-models"];
  if (!Array.isArray(featuredModels)) {
    throw new Error('Unexpected featured model catalog response: expected "featured-models" array');
  }

  return featuredModels
    .map((item) => {
      const id = typeof item?.model === "string" ? normalizeFeaturedModelId(item.model) : "";
      const label =
        typeof item?.["model-name"] === "string"
          ? normalizeFeaturedModelLabel(id, item["model-name"])
          : "";
      return id && label && isSafeModelId(id) ? { id, label } : null;
    })
    .filter((value): value is FeaturedModelOption => value !== null);
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
    return { ok: true, models: parseNvidiaFeaturedModels(result.body) };
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
  return result.ok && result.models.length > 0 ? result.models : CLOUD_MODEL_OPTIONS;
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
  return {
    defaultModelId: defaultModelId || DEFAULT_CLOUD_MODEL,
    cloudModelOptions: getNvidiaFeaturedModelOptions(options),
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
