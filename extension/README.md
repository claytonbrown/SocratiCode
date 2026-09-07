<p align="center">
  <img src="https://raw.githubusercontent.com/giancarloerra/socraticode/main/socraticode_logo.png" alt="SocratiCode" width="160">
</p>

<h1 align="center">SocratiCode</h1>

<p align="center"><strong>The codebase context engine for AI assistants.</strong><br>
Same understanding of your code, every assistant, every tool switch.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=giancarloerra.socraticode"><img src="https://vsmarketplacebadges.dev/version-short/giancarloerra.socraticode.svg?style=flat-square&label=VS%20Code%20Marketplace&logo=visualstudiocode&color=0098FF" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=giancarloerra.socraticode"><img src="https://vsmarketplacebadges.dev/installs-short/giancarloerra.socraticode.svg?style=flat-square&label=installs" alt="Installs"></a>
  <a href="https://open-vsx.org/extension/giancarloerra/socraticode"><img src="https://img.shields.io/open-vsx/v/giancarloerra/socraticode?style=flat-square&label=Open%20VSX" alt="Open VSX"></a>
  <a href="https://open-vsx.org/extension/giancarloerra/socraticode"><img src="https://img.shields.io/open-vsx/dt/giancarloerra/socraticode?style=flat-square&label=downloads" alt="Open VSX Downloads"></a>
  <a href="https://github.com/giancarloerra/socraticode"><img src="https://img.shields.io/github/stars/giancarloerra/socraticode?style=flat-square&logo=github&label=stars" alt="GitHub stars"></a>
  <a href="https://discord.gg/dHNMKVY2J2"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://www.npmjs.com/package/socraticode"><img src="https://img.shields.io/npm/v/socraticode?style=flat-square&logo=npm&label=engine" alt="npm engine"></a>
  <a href="https://github.com/giancarloerra/socraticode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/giancarloerra/socraticode#readme">Full documentation, configuration reference, and benchmarks on GitHub →</a></strong>
</p>

---

> **The big number.** On a 2.45M-line codebase, SocratiCode answers the same architectural question with **61% less context burned**, **84% fewer tool calls**, and **37x faster** than a grep-based AI agent. Same model, dramatically better answers. [Full benchmark on GitHub.](https://github.com/giancarloerra/socraticode#real-world-benchmark-vs-code-245m-lines-of-code-with-claude-opus-46)

On Microsoft VS Code 1.99+ and compatible editors that implement the VS Code
MCP provider API, this extension registers SocratiCode with the editor's native
MCP registry. Independent clients such as Cline, Continue, and Roo Code require
their own MCP configuration.

## What it does

- **Hybrid search** (semantic + BM25, fused via Reciprocal Rank Fusion).
  Tested on codebases over 40 million lines.
- **File-level dependency graphs** across 18+ languages with circular-
  dependency detection.
- **Symbol-level call graph and impact analysis**: answers
  *"what breaks if I change function X?"* before the AI changes it.
- **Call-flow tracing** from any entry point, so onboarding to a
  legacy module takes minutes instead of days.
- **Cross-repo search** across linked workspaces. The bug is in the
  API gateway and the AI is looking at the front-end? It sees the
  full system in one query.
- **Interactive graph viewer** with blast-radius overlay, search,
  click-to-open-file, and PNG export. Opens directly inside the editor
  as a webview panel.
- **Context artefacts**: index database schemas, API specs and
  architecture docs alongside code. The AI sees the schema your team
  designed, not what it guessed from filenames.
- **Branch-aware indexing**: every branch gets its own index, so PR
  reviews see the code actually being reviewed.

## Built for real-world big teams and projects

- **Refactor safety on a monorepo.** Blast-radius analysis surfaces
  every file and symbol that calls into a target before any change
  goes in. Particularly useful in regulated and legacy contexts.
- **Multi-repo orgs.** Cross-project search treats your microservices
  as one searchable surface, not N disconnected repos.
- **Tool-independent.** Move from Cursor to Copilot to Cline to
  whatever ships next. The index, dependency graphs and context
  artefacts survive every tool switch. No vendor lock-in.
- **Air-gapped friendly.** The default deployment runs entirely on
  your machine via Docker (Qdrant + Ollama). Code never leaves the
  network unless you explicitly point at an external service via the
  `socraticode.env` setting.
- **Open source at the core (AGPL-3.0).** Battle-tested across thousands
  of repositories. Every component that touches your code is inspectable.
- **18+ languages out of the box.** TypeScript, JavaScript, Python, Go,
  Rust, Java, Kotlin, Scala, C#, C, C++, Ruby, PHP, Swift, Bash, Dart,
  Lua, Svelte, Vue, plus 35+ plain-text formats.

## Quick start

1. **Install the extension.** Search **SocratiCode** in the Extensions panel
   and install it in the current editor profile from Visual Studio Marketplace
   or Open VSX.
2. **Activate and verify it.** In Microsoft VS Code, reload the window, start a
   new native Agent Chat, and run `MCP: List Servers`. Confirm that
   `SocratiCode` is listed and running. In another compatible editor, follow
   that host's [integration instructions](https://github.com/giancarloerra/socraticode#plugins-and-host-integrations)
   and verify through its own MCP server list.
3. **Index the workspace.** Open the SocratiCode sidebar (Activity Bar
   icon) and click *Index this workspace*. A local Ollama setup downloads
   its embedding model on first use if it is not already available; cloud
   and external providers do not. Subsequent updates are incremental.
4. **Ask anything.** In Microsoft VS Code, use native Agent Chat. In another
   compatible editor, use that host's available agent or chat interface after
   verifying the MCP provider. Ask: "where is auth handled?", "what breaks if
   I change `processOrder`?", "trace the nightly cron job", or "what tables
   does this API touch?".
5. **Open the interactive graph.** Command Palette →
   `SocratiCode: Open interactive graph`.

A walkthrough is shown on first install; re-open it any time via
`SocratiCode: Open getting-started walkthrough`.

## Requirements

- Microsoft VS Code 1.99+, or a compatible editor that implements
  `vscode.lm.registerMcpServerDefinitionProvider`.
- To verify tools in Microsoft VS Code's native Agent Chat, enable AI features
  and agents (`chat.agent.enabled`) and provide an available model through
  GitHub Copilot or another supported configured provider. When using Copilot,
  sign in with the account that has access and keep GitHub Copilot Chat current.
  Organization policy can disable agents or restrict model access.
- Node.js 18.17+ with `npx` on `PATH` (the engine launches via `npx`).
- Docker running for the default managed Qdrant and Ollama stack.
  Docker is optional when Qdrant is external and embeddings use either a
  detected native Ollama instance or a cloud or external provider. Configure
  these modes through `socraticode.env`; see Settings.

## Commands

All commands appear under `SocratiCode:` in the Command Palette.

- `SocratiCode: Index current workspace`: kick off a one-time index.
- `SocratiCode: Open interactive graph`: render the dependency / call
  graph as an in-editor webview.
- `SocratiCode: Refresh indexed projects`: reload the sidebar tree.
- `SocratiCode: Open getting-started walkthrough`: replay the onboarding.
- `SocratiCode: Show output / logs`: open the SocratiCode output channel.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `socraticode.command` | `"npx"` | Engine launcher. |
| `socraticode.args` | `["-y", "--prefer-online", "socraticode@latest"]` | Args for the launcher. npm checks for the latest published engine whenever the server starts. |
| `socraticode.env` | `{}` | Environment variables forwarded to the engine. Use this to point at an external Qdrant cluster (`QDRANT_MODE=external`, `QDRANT_URL`, `QDRANT_API_KEY`), pick an embedding provider (`EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`), enable branch-aware indexing, link multiple projects, or set any other engine knob from the [engine README](https://github.com/giancarloerra/socraticode#configuration). |
| `socraticode.statusBar` | `true` | Show the status-bar item. |

## Compatibility

Microsoft VS Code Stable and Insiders implement the MCP provider API used by
this extension. Open VSX makes the package available to VS Code-derived
editors, but package installation alone does not prove that a host implements
that API. In Microsoft VS Code, verify registration with `MCP: List Servers`.
In another editor, use its own MCP server list. If SocratiCode is unavailable,
configure it through that host's local stdio MCP settings.

The extension registers only with the editor's native MCP host. It does not
write configuration for Cursor Agent, Cline, Continue, Roo Code, or another
independent client.

## Updating

In Microsoft VS Code, use the Extensions view or run
`Extensions: Check for Extension Updates`, reload the window, start a new native
Agent Chat, and verify the final version and server with `MCP: List Servers`.
This updates the extension's UI and integration files. The separately launched
MCP engine checks npm for the latest published release whenever that server
starts, using the default `socraticode.args` shown above.
In another editor, use that host's extension update flow, restart or reload it
as documented, verify the registered MCP provider through its server list, and
use its available agent or chat interface. See the
[host integration instructions](https://github.com/giancarloerra/socraticode#plugins-and-host-integrations).

## SocratiCode Cloud (private beta)

The same engine, hosted by us. Adds managed infrastructure (no Docker
or Qdrant or Ollama on your machine), webhook-driven auto-indexing on
every push and every branch, shared team indexes across your whole
organisation, SSO/SAML, audit logs, and SOC 2 / ISO 27001-aligned
controls. Currently in private beta.

[Request access at socraticode.cloud →](https://socraticode.cloud)

## Privacy and data

- The engine indexes locally by default. Code never leaves your
  machine unless you explicitly configure an external service via
  `socraticode.env`.
- No telemetry from the extension.
- The engine is open source under AGPL-3.0; every component that
  touches your code is inspectable.

## Learn more

The extension is the install surface. The full picture lives in the
project repo:

- **[Full README, configuration reference, and benchmark methodology](https://github.com/giancarloerra/socraticode#readme)**
- [Issues and feature requests](https://github.com/giancarloerra/socraticode/issues)
- [Discord community](https://discord.gg/dHNMKVY2J2)

## Troubleshooting

- **"Cannot find Docker"**: install and start
  [Docker](https://docker.com/products/docker-desktop/). Docker-free operation
  requires external Qdrant plus either a detected native Ollama instance or a
  cloud or external embedding provider; configure those modes through
  `socraticode.env`.
- **MCP tools don't appear in the native agent**: reload the window and start a
  new chat. In Microsoft VS Code, run `MCP: List Servers` and confirm that
  `SocratiCode` is listed and started. In another editor, use its MCP server
  list or follow the [host integration instructions](https://github.com/giancarloerra/socraticode#plugins-and-host-integrations).
- **First local index is slow**: a local Ollama setup downloads the embedding
  model if it is not already available. Cloud and external providers do not.
  Subsequent runs are fast.
- **Anything else**: `SocratiCode: Show output / logs` from the
  command palette has the engine output.

## License

[AGPL-3.0-only](https://github.com/giancarloerra/socraticode/blob/main/LICENSE).
The engine and this extension are open source.
