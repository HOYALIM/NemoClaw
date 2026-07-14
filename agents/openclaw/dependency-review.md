<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Runtime Dependency Review

## OpenClaw production runtime graph

- Package: `openclaw@2026.6.10`.
- Registry source: `https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz`.
- npm integrity: `sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==`.
- NemoClaw lock: `agents/openclaw/openclaw-runtime/package-lock.json` (npm lockfile version 3, 306 package entries).
- Lock SHA-256: `a0f91c7e0b769e73c3f6119b2a6ee2dfd9bcb32b3dc69655b22696c654694d2d`.
- Deterministic regeneration: `cd agents/openclaw/openclaw-runtime && npx --yes npm@10.9.4 install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ --userconfig=/dev/null`.
- Installation boundary: both current production Docker paths validate the lock digest, exact root version/SRI/tarball, official registry origin, and sha512 metadata for every transitive entry before `npm ci --ignore-scripts --omit=dev` consumes that lock. They then bind every installed non-optional package location to the lock's exact manifest name and version, reject symlinked package roots or manifests, invoke the reviewed bundled-plugin postinstall, and only then expose the dedicated runtime through the canonical global package and binary symlinks.
- Provenance: `openclaw-base-provenance-v1` schema 3 records the lock SHA-256 and `locked-ci+reviewed-lifecycle-v2` recipe. A final image reuses a base install only when the protected marker, installed OpenClaw version, installed mcporter version, and both lock identities match.
- Default audit: `scripts/audit-reviewed-npm-graph.mts` validates and installs this same lock under Node `22.22.2`, verifies the installed manifest identities, runs `npm audit --omit=dev --json`, uploads the raw report, and fails at the threshold in `ci/reviewed-npm-audit.json`.
- Regression: `test/openclaw-locked-install.test.ts` rejects lock-byte, root-version, integrity, missing-transitive-SRI, registry-origin, installed-manifest, and symlink drift and keeps both Docker install paths, CI audit ownership, base-image rebuild triggers, and provenance synchronized. The integrity-pin suite injects `npm ci` and reviewed lifecycle failures and proves neither runtime symlinks nor base provenance are published.

The lock is a NemoClaw-owned review artifact materialized from the pinned official npm package. The package-internal shrinkwrap is upstream evidence, but production installation and CI audit consume the committed NemoClaw lock rather than independently resolving the transitive graph.

## mcporter runtime graph

This section records the reviewed `mcporter` baseline installed in the OpenClaw sandbox image.
Update it and `agents/openclaw/mcporter-runtime/package*.json` together whenever `MCPORTER_VERSION` or its integrity value changes in `Dockerfile.base` or `Dockerfile`.

- Package: `mcporter@0.7.3`
- Purpose: in-sandbox OpenClaw MCP configuration and client adapter; it is not a host bridge, proxy, relay, or listener.
- Registry source: `https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz`
- Repository: `https://github.com/steipete/mcporter`
- License: `MIT`, from the npm registry package metadata.
- npm integrity: `sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==`
- Registry metadata independently queried from npm: 2026-06-30.
- Locked graph: `agents/openclaw/mcporter-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration command: `npm --prefix agents/openclaw/mcporter-runtime install --package-lock-only --ignore-scripts --omit=dev`
- Advisory command: `npm --prefix agents/openclaw/mcporter-runtime ci --ignore-scripts --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit signatures`
- Advisory review date: 2026-06-30.
- Advisory result: `0` known vulnerabilities across the resolved production dependency graph; npm verified registry signatures for all `120` resolved packages and attestations for `12` packages.

Both image paths install the committed graph with `npm ci --ignore-scripts --omit=dev` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.

## WeChat plugin runtime graph

- Package: `@tencent-weixin/openclaw-weixin@2.4.3`.
- Locked graph: `agents/openclaw/wechat-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --omit=dev --prefix agents/openclaw/wechat-runtime`.
- Installation boundary: the image materializes the reviewed lock into a root-owned dedicated npm cache and adds the exact package metadata needed by npm's offline resolver. Before that cache becomes immutable, the shared `scripts/lib/reviewed-npm-archive.mts` implementation re-packs every locked archive offline from the final cache and rejects registry-origin drift, metadata or packed-byte SRI drift, unsafe filenames, missing archives, and symlinks. The sandbox user copies that verified immutable source into a writable cache used for registry metadata lookup, archive packing, and the OpenClaw plugin install; no retrieval step falls back to `HOME/.npm`. The copy is deleted in the same image layer, and the trusted cache is never writable. The installer runs in offline, legacy-peer mode, then `verify-wechat-runtime-lock.mts` rejects integrity, version, dependency-set, or peer-range drift and refuses an image OpenClaw version below the plugin's locked peer minimum.
- Default CI gate: `wechat-runtime-audit` in `.github/workflows/pr.yaml` and `.github/workflows/main.yaml` invokes the reviewed `.github/actions/ci-wechat-runtime-audit` implementation. Pull requests resolve it from the base SHA. Because PR #6739's base predates the action, that PR alone may bootstrap the action from signed immutable commit `HOYALIM/NemoClaw@0d2256d71d5bbba3bcaaaa4d01714fa56f22d1e2`; every other PR fails closed if its base lacks the action. Main uses the merged action. The action uses Node `22.19.0` and npm `10.9.4`, materializes the committed graph with scripts disabled, fails on any low-or-higher production advisory, verifies registry signatures, uploads the JSON/text reports, and exercises the exact reviewed archive through a copied writable cache while the trusted source remains read-only. Removal condition: delete the PR #6739 bootstrap checkout, its paired conditional audit step, and the bootstrap-specific test assertions in the first follow-up after this PR merges, before the next release tag; all later PRs must use the normal base-SHA action path.
- Advisory command: `npm ci --ignore-scripts --omit=dev --legacy-peer-deps --prefix agents/openclaw/wechat-runtime && npm audit --omit=dev --audit-level=low --json --prefix agents/openclaw/wechat-runtime && npm audit signatures --prefix agents/openclaw/wechat-runtime`.
- Advisory review: `2026-07-12`; result: `0` known vulnerabilities across the resolved production graph.
- Regression tests: `test/wechat-locked-install.test.ts` keeps the manifest runtime-lock paths and installer verification dispatch synchronized; `test/verify-wechat-runtime-lock.test.ts` proves the installed graph and OpenClaw peer-range compatibility fail closed; `test/wechat-runtime-audit-workflow.test.ts` keeps the Docker cache lifecycle, base-trusted required CI gate, evidence upload, audit threshold, signature verification, and real npm-pack boundary synchronized.

The dedicated graph intentionally omits the plugin's `openclaw` peer dependency. The image already installs and integrity-verifies the reviewed OpenClaw runtime separately; auto-installing another OpenClaw copy would create a second unreviewed runtime graph.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The lock records the exact version, registry URL, and integrity for every transitive package; the top-level registry integrity check remains an independent control.

## Source-of-Truth Boundary

- `invalidState`: the image installs a package graph, tarball, license, or advisory state that differs from the independently queried npm registry records for `mcporter@0.7.3`.
- `sourceBoundary`: npm owns registry metadata, tarball integrity, provenance signatures, and advisory responses; NemoClaw owns the exact lock, script-disabled install, Docker integrity assertion, and review record.
- `whyNotSourceFix`: a repository note cannot make external registry state trustworthy, so image builds execute `npm audit` and `npm audit signatures` against the locked production graph and reviewers compare the lock with the registry response.
- `regressionTest`: `test/mcporter-supply-chain.test.ts` keeps the version, integrity, lock metadata, Docker install flags, audit commands, and this review synchronized.
- `removalCondition`: remove this runtime dependency and review when OpenClaw provides the required authenticated Streamable HTTP client lifecycle without mcporter, or repeat the independent review for a newly pinned version.
