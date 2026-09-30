<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Pi packages](packages/coding-agent/docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Pi TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](https://pi.dev/docs/latest) for full setup and usage instructions, or [visit pi.dev](https://pi.dev) for demos.

## Run with Nix

```bash
nix run github:earendil-works/pi/stable
```

`stable` points at the latest release. Install it with `nix profile add github:earendil-works/pi/stable` and update with `nix profile upgrade pi`. Use a release tag such as `github:earendil-works/pi/v1.0.0` to pin a version, or `github:earendil-works/pi` for unreleased changes on `main`. Nix builds Pi from source.

Supports ARM64 and x86-64 on Linux and macOS. Use `nix build .` or `nix run .` to build or run your checkout.

Nix builds are offline, so the bundled model data comes from a pi.dev model catalog revision pinned in `nix/model-catalog.json`. At runtime, Pi still overlays newer catalog data from pi.dev as usual. The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type. To refresh it by hand:

```bash
npm run update:model-catalog-pin
```

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## zkao fork maintenance

This is a fork. `zkao` is our long-lived working branch and is periodically rebased onto `main` (upstream releases). Before each rebase we snapshot `zkao` into a backup branch named `zkao-v<version>-backup`, where `<version>` is the upstream release `zkao` was synced to at that time. See [AGENTS.md](AGENTS.md) for the full procedure.

| Backup branch | Synced version | Date | Notes |
|---------------|----------------|------|-------|
| `zkao-v0.75.5-backup` | v0.75.5 | 2026-05-28 | Snapshot before rebasing onto `main` (v0.77.0); web search support + zkao CI/release workflows |
| `zkao-v0.77.0-backup` | v0.77.0 | 2026-06-06 | Snapshot before rebasing onto `main` (v0.78.1); Gemini web-search × function-calling combination fix |
| `zkao-v0.78.1-backup` | v0.78.1 | 2026-06-09 | Snapshot before rebasing onto `main` (v0.79.0); client/provider tool-name collision fix, Codex SSE read-timeout fix, Gemini web-search tool conversion tests |
| `zkao-v0.79.0-backup` | v0.79.0 | 2026-06-12 | Snapshot before rebasing onto `main` (v0.79.1); preserves our Claude Fable 5 support commit, dropped during the rebase in favor of upstream's own Fable 5 metadata |
| `zkao-v0.79.1-backup` | v0.79.1 | 2026-06-20 | Snapshot before rebasing onto `main` (v0.79.8); dropped our cherry-picked Fable 5 adaptive-thinking test commit (superseded upstream), re-resolved web-search vs. refusal-detail conflicts |
| `zkao-v0.79.8-backup` | v0.79.8 | 2026-06-29 | Snapshot before rebasing onto `main` (v0.80.2); re-ported every fork commit onto the upstream Models-runtime refactor, which moved provider stream/convert logic from `providers/*.ts` into `api/*.ts` |
| `zkao-v0.80.2-backup` | v0.80.2 | 2026-07-08 | Snapshot before rebasing onto `main` (v0.80.3); re-resolved the `agent.ts` `prepareNextTurn` conflict; includes the `streamProxy` fix that relays `nativeTools` (native web search was silently dropped through the proxy) |
| `zkao-v0.80.3-backup` | v0.80.3 | 2026-07-09 | Snapshot before rebasing onto `main` (v0.80.6, which adds the GPT-5.6 luna/sol/terra models); dropped our signed empty-thinking implementation (upstream absorbed the same fix) and kept only its regression test |
| `zkao-v0.80.6-backup` | v0.80.6 | 2026-07-14 | Snapshot before rebasing onto `main` (v0.80.7, which adds a codex session-id clamp); preserves the new Meta (Muse Spark) provider commit alongside every prior fork commit |
| `zkao-v0.80.7-backup` | v0.80.7 | 2026-07-16 | Snapshot before rebasing onto `main` (v0.80.9); preserves the Meta Muse `replayReasoning` fix (skip replaying server-expiring reasoning items) alongside every prior fork commit |
| `zkao-v0.80.9-backup` | v0.80.9 | 2026-07-20 | Snapshot before rebasing onto `main` (v0.80.10); preserves the native web-search pricing fix (xAI/Meta) and the new DeepInfra provider alongside every prior fork commit |
| `zkao-v0.80.10-backup` | v0.80.10 | 2026-07-24 | Snapshot before rebasing onto `main` (v0.82.0); dropped the OpenCode Go API-widening commit absorbed upstream and re-resolved native web-search, Gemini combined-tool, Meta reasoning-replay, and DeepInfra conflicts |
| `zkao-v0.82.0-backup` | v0.82.0 | 2026-07-25 | Snapshot before rebasing onto `main` (v0.82.1); took upstream's e2e test-model retarget (`gpt-5.5`) over our equivalent fork hunks, and added the env-api-keys `.catch` fix for bundler-substituted rejecting imports (Turbopack unhandled rejections) |
| `zkao-v0.82.1-backup` | v0.82.1 | 2026-08-04 | Snapshot before rebasing onto `main` (v0.83.0); adds refusal/account-restriction classification, the model downgrade fallback runner, and the `createAgentSession` stream-function wrapper. Re-resolved the DeepInfra `useMaxTokens` conflict (union with upstream's `isZai`), took upstream's new `"Provider stopped with: sensitive"` errorMessage over our equivalent fork hunk and matched it from the classifier instead, and handled the new `"pending"` stop reason in terminal-event mapping |
| `zkao-v0.83.0-backup` | v0.83.0 | 2026-08-06 | Snapshot before rebasing onto `main` (v0.84.0); adds Muse Spark 1.2 as the Meta default. Re-ported every fork commit onto upstream's `StreamOptions` → `ProviderRequestOptions` split (our `nativeTools` and native-tool-collision helpers moved with it), took our omit-based `streamProxy` relay over upstream's hand-maintained allowlist (which had grown `samplingParams`), and unioned the `servertooluse` event with upstream's new `"deferred"` done reason. Adapted our additions to the brand-new `packages/server/src/protocol.ts` conformance guards: `Usage.extras`/`cost.extras` declared server-side, `serverToolUse` blocks dropped from the transcript projection |
| `zkao-v0.84.0-backup` | v0.84.0 | 2026-08-12 | Snapshot before rebasing onto `main` (v0.84.1); all 32 fork commits replayed cleanly with no conflicts and none absorbed upstream. The rebase target adds GPT Daybreak Blue to the Codex catalog. Note that `npm run check` and one OpenCode test fail identically on a pristine v0.84.1 tree once the catalogs are regenerated from live APIs: Google dropped `gemini-2.0-flash`, and OpenCode Zen moved `grok-build-0.1` from the completions API to the Responses API |
| `zkao-v0.84.1-backup` | v0.84.1 | 2026-08-20 | Snapshot before rebasing onto `main` (v0.84.2); all 34 fork commits replayed and none absorbed upstream, but six conflicts needed re-resolution against upstream's strict tool-schema work: kept our Codex `response.completed` guard wrapped around upstream's now `output`-aware `mapCodexEvents`, threaded `supportsStrictMode` into the `convertTools` call feeding our Google native-search `tools` array (generative-ai and vertex), took upstream's `getJsonSchemaToolParameters` strict conversion over our equivalent `openai-responses-shared` hunks, unioned upstream's brand-new `proxy.test.ts` with our `streamProxy` serialization tests (add/add on the same path; our model const renamed to `anthropicModel`), dropped `KIMI_STATIC_HEADERS` (removed upstream) while keeping `DEEPINFRA_BASE_URL`, and unioned upstream's `isDeepSeek` into `useMaxTokens` alongside our `isDeepInfra`. Catalogs were regenerated from live APIs: DeepInfra now carries Qwen3.8-Max, Qwen3.8-2.4T-A95B, Qwen3.8-27B and Kimi K3 (no GLM 5.3 yet; 5.2 is the newest). Note that `npm run check` and one Baseten test fail identically on a pristine v0.84.2 tree once the catalogs are regenerated: Cloudflare AI Gateway renamed `claude-sonnet-4-5` to `claude-sonnet-4.5`, and Baseten now reports GLM-5.2 as accepting image input |
| `zkao-v0.84.2-backup` | v0.84.2 | 2026-09-01 | Snapshot before rebasing onto `main` (v0.84.4); 38 fork commits replayed, two dropped as absorbed upstream (the Cloudflare gateway e2e retarget to `claude-sonnet-4.5` and the Baseten GLM-5.2 image-input test), leaving 36. Four conflicts re-resolved against upstream's new opt-in Anthropic server-side refusal fallback (`refusalFallbacks`, independent of our client-side refusal classifier and downgrade runner): our `webSearch` usage extras now precede upstream's `calculateCost(usageModel, …)` in both Anthropic usage paths, our `enabledServerToolNames` set precedes upstream's renamed `MessageCreateParamsStreamingWithFallbacks` params, and the `google-shared` import lists were unioned (`GoogleSearch`, `NativeWebSearchOptions`, `ThinkingContent` alongside upstream's `ModelThinkingLevel`/`ThinkingLevel`). Upstream now records the response model from `message_start` for fallback pricing, so the server-tool round-trip test fixture had to carry `model` or the transform would strip its signed thinking blocks as a cross-model replay. Catalogs regenerated from live APIs matched upstream's tree exactly and `npm run check` passes clean |
| `zkao-v0.84.4-backup` | v0.84.4 | 2026-09-05 | Snapshot before rebasing onto `main` (v0.85.1, which adds GPT-6 Astra); 38 fork commits replayed, one dropped as obsolete (the v0.84 protocol-guard fix: upstream removed `packages/server/src/protocol.ts` and its exhaustive pi-ai field guards in favor of the service-addressed `packages/protocol` RPC, so `Usage.extras` and `serverToolUse` no longer need a server-side exemption), leaving 37. A teammate's Claude Code OAuth version bump (`claudeCodeVersion` 2.1.251), pushed to `zkao` on 2026-09-04 after this session's backup was taken, was already absorbed by v0.85.1; its `user-agent` assertion was cherry-picked onto the rebased branch and the original commit merged into the backup branch so it stays reachable. Four conflicts re-resolved: took upstream's EOF flush of the residual Codex SSE frame inside our read-timeout loop; unioned our `replayReasoning` compat flag with upstream's new `supportsMaxOutputTokens`; re-threaded `enabledServerToolNames` through upstream's hoisted `convertMessages` call (appended after its new `managedProvider` parameter) and moved our server-tool and web-search typings onto the Beta SDK aliases (`BetaServerToolUseBlock`, `BetaToolUnion`, `BetaWebSearchTool20250305`) now that upstream drives `client.beta.messages`; and unioned the Daybreak Blue predicates with upstream's `gpt-6-astra` checks (tool search, xhigh, max effort). Adds Muse Spark 1.3 as the Meta default, and two follow-up fork commits for new upstream guards: a per-entry override in `scripts/check-entry-graphs.mjs` so our five-file `./utils/fallback` runner passes the new three-file utils budget, and `beta`-namespaced fake Anthropic clients in our tests now that the provider calls `client.beta.messages`. Catalogs regenerated from live APIs matched upstream's tracked tree exactly; `npm run build` and `npm run check` pass clean, and the AI suite passes except upstream's untouched `stream.test.ts` Codex gpt-5.4 e2e block, which errors with `The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account` (an account entitlement, unrelated to the rebase) |

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
| `zkao-v0.85.1-backup` | v0.85.1 | 2026-09-27 | Snapshot before rebasing onto `main` (v0.87.1, which moves tools and the system prompt into transcript system messages and adds an upstream Meta provider with Muse subscription OAuth); 41 fork commits replayed, three dropped as absorbed upstream (our Meta provider and the Muse Spark 1.2/1.3 default bumps: upstream now sources Meta from models.dev with `muse-spark-1.3` as default; our `MODEL_API_KEY` env fallback is gone, only `META_API_KEY` remains), leaving 38 plus one new adaptation commit. Re-resolved native web search onto upstream's transcript tools (`transcriptTools.requestTools` for the Responses/Codex/Azure providers, `currentTools` for Google, the web-search tool appended after upstream's `nativeToolChanges` branch for Anthropic), `enabledServerToolNames` alongside the new `nativeToolChanges` `convertMessages` parameter, the native-tool collision guard onto upstream's `AgentInitialState`, the `createAgentSession` stream-function wrapper around upstream's cache-warming stream function, `replayReasoning: false` moved into upstream's models.dev Meta loop, DeepInfra alongside Radius in the generator, and Daybreak Blue unioned with upstream's `gpt-6` checks. The adaptation commit fixes Google `hasFunctionTools`, makes fallback diagnostic `usage` JsonValue-safe, and updates fork tests (`normalizeContext`, DeepInfra fetch mock, Claude Code version 2.1.280, DeepInfra smoke IDs). Live-regenerated catalogs had drifted from v0.87.1 (Fireworks/OpenRouter IDs in upstream's own tests), so checks were run against the catalog JSON from the published `@earendil-works/pi-ai@0.87.1` tarball plus our live `deepinfra.json`; with that, `npm run build`, `npm run check`, and the full AI suite pass |
| `zkao-v0.87.1-backup` | v0.87.1 | 2026-10-01 | Snapshot before rebasing onto `main` (v0.99.2, which splits provider catalogs into chat/image/classifier exports); all 40 fork commits replayed, none dropped. Re-resolved the Codex SSE completion guard around upstream's new `onProviderStreamEvent` argument, native web search's `include` set ahead of upstream's model-level `samplingParams` merge (Responses and Azure), DeepInfra into upstream's `openRouterCatalog.chat`/`aiGatewayCatalog.chat` generator lists, `usage_limit_reached` alongside upstream's `subscription_sharing_usage_limit_exceeded` in retry, Daybreak Blue after upstream's `gpt-6.1-sol`, the fallback entry-graph override next to upstream's new `./models` budget, and the DeepInfra fetch mock onto upstream's `startsWith` OpenRouter match. New adaptation commit regenerates DeepInfra in the split catalog shape (now listing GLM-5.3 / GLM-5.3-Flash) and raises the `packages/durable` entry budget 58 -> 59 for `utils/refusal.ts`. `npm run build`, `npm run check`, and the full AI suite pass |
