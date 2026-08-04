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

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
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

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

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

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
