// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare const trustedPrivateEndpointCapabilityBrand: unique symbol;

/** Ephemeral proof that SSRF preflight admitted an exact set of private addresses. */
export interface TrustedPrivateEndpointCapability {
  readonly addresses: readonly string[];
  readonly [trustedPrivateEndpointCapabilityBrand]: true;
}

const issuedCapabilities = new WeakSet<object>();

/** Issue an immutable capability without exposing the mutable provenance registry. */
export function issueTrustedPrivateEndpointCapability(
  addresses: readonly string[],
): TrustedPrivateEndpointCapability {
  const capability = Object.freeze({
    addresses: Object.freeze([...new Set(addresses)]),
  }) as unknown as TrustedPrivateEndpointCapability;
  issuedCapabilities.add(capability);
  return capability;
}

/** Return true only for a capability issued by this module instance. */
export function isTrustedPrivateEndpointCapability(
  value: unknown,
): value is TrustedPrivateEndpointCapability {
  return typeof value === "object" && value !== null && issuedCapabilities.has(value);
}
