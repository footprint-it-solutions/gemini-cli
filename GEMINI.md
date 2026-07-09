# Gemini CLI Project Context

Gemini CLI is an open-source AI agent that brings the power of Gemini directly
into the terminal. It is designed to be a terminal-first, extensible, and
powerful tool for developers.

## Project Overview

- **Purpose:** Provide a seamless terminal interface for Gemini models,
  supporting code understanding, generation, automation, and integration via MCP
  (Model Context Protocol).
- **Main Technologies:**
  - **Runtime:** Node.js (>=20.0.0, recommended ~20.19.0 for development)
  - **Language:** TypeScript
  - **UI Framework:** React (using [Ink](https://github.com/vadimdemedes/ink)
    for CLI rendering)
  - **Testing:** Vitest
  - **Bundling:** esbuild
  - **Linting/Formatting:** ESLint, Prettier
- **Architecture:** Monorepo structure using npm workspaces.
  - `packages/cli`: User-facing terminal UI, input processing, and display
    rendering.
  - `packages/core`: Backend logic, Gemini API orchestration, prompt
    construction, and tool execution.
  - `packages/a2a-server`: Experimental Agent-to-Agent server.
  - `packages/sdk`: Programmatic SDK for embedding Gemini CLI capabilities.
  - `packages/devtools`: Integrated developer tools (Network/Console inspector).
  - `packages/test-utils`: Shared test utilities and test rig.
  - `packages/vscode-ide-companion`: VS Code extension pairing with the CLI.

## Building and Running

- **Install Dependencies:** `npm install`
- **Build All:** `npm run build:all` (Builds packages, sandbox, and VS Code
  companion)
- **Build Packages:** `npm run build`
- **Run in Development:** `npm run start`
- **Run in Debug Mode:** `npm run debug` (Enables Node.js inspector)
- **Bundle Project:** `npm run bundle`
- **Clean Artifacts:** `npm run clean`

## Testing and Quality

- **Test Commands:**
  - **Unit (All):** `npm run test`
  - **Integration (E2E):** `npm run test:e2e`
  - > **NOTE**: Please run the memory and perf tests locally **only if** you are
    > implementing changes related to those test areas. Otherwise skip these
    > tests locally and rely on CI to run them on nightly builds.
  - **Memory (Nightly):** `npm run test:memory` (Runs memory regression tests
    against baselines. Excluded from `preflight`, run nightly.)
  - **Performance (Nightly):** `npm run test:perf` (Runs CPU performance
    regression tests against baselines. Excluded from `preflight`, run nightly.)
  - **Workspace-Specific:** `npm test -w <pkg> -- <path>` (Note: `<path>` must
    be relative to the workspace root, e.g.,
    `-w @google/gemini-cli-core -- src/routing/modelRouterService.test.ts`)
- **Full Validation:** `npm run preflight` (Heaviest check; runs clean, install,
  build, lint, type check, and tests. Recommended before submitting PRs. Due to
  its long runtime, only run this at the very end of a code implementation task.
  If it fails, use faster, targeted commands (e.g., `npm run test`,
  `npm run lint`, or workspace-specific tests) to iterate on fixes before
  re-running `preflight`. For simple, non-code changes like documentation or
  prompting updates, skip `preflight` at the end of the task and wait for PR
  validation.)
- **Individual Checks:** `npm run lint` / `npm run format` / `npm run typecheck`

## Development Conventions

- **Contributions:** Follow the process outlined in `CONTRIBUTING.md`. Requires
  signing the Google CLA.
- **Pull Requests:** Keep PRs small, focused, and linked to an existing issue.
  Always activate the `pr-creator` skill for PR generation, even when using the
  `gh` CLI.
- **Commit Messages:** Follow the
  [Conventional Commits](https://www.conventionalcommits.org/) standard.
- **Imports:** Use specific imports and avoid restricted relative imports
  between packages (enforced by ESLint).
- **License Headers:** For all new source code files (`.ts`, `.tsx`, `.js`),
  include the Apache-2.0 license header with the current year. (e.g.,
  `Copyright 2026 Google LLC`). This is enforced by ESLint.

## Testing Conventions

- **Environment Variables:** When testing code that depends on environment
  variables, use `vi.stubEnv('NAME', 'value')` in `beforeEach` and
  `vi.unstubAllEnvs()` in `afterEach`. Avoid modifying `process.env` directly as
  it can lead to test leakage and is less reliable. To "unset" a variable, use
  an empty string `vi.stubEnv('NAME', '')`.

### Behavioral and evaluation testing (BDD) mandate

- **User journey simulation (Strict):** All BDD and evaluation tests must
  simulate genuine, end-to-end user journeys using the real, in-process
  application (such as `OllamaAppRig` or `AppRig`). Tests that rely on isolated
  mocks or static assertions are forbidden for behavioral checks, as they fail
  to capture real-world execution, terminal UI renders, and conversational
  history.
- **Minimum turn depth:** To prove conversational and scheduler resilience, BDD
  tests must execute and complete at least five full turns of user-assistant
  interaction. Single-turn tests do not prove continuation or history sanity.
- **LLM-based evaluation:** Use an independent, strict Quality Assurance LLM
  (such as AWS Bedrock Nova Micro) to assess output completeness and veracity.
  Do not use fragile, rigid static string analysis for BDD tests. The evaluator
  model must determine whether the TUI output satisfies the prompt's semantic
  goals.

## Documentation

- Always use the `docs-writer` skill when you are asked to write, edit, or
  review any documentation.
- Documentation is located in the `docs/` directory.
- Suggest documentation updates when code changes render existing documentation
  obsolete or incomplete.

## Low-Conflict Fork Principle (Fork Mandate)

To guarantee that this repository can be rebased smoothly from Google's upstream
`master` branch with minimal manual conflict resolution:

- **Zero-Conflict Files:** Whenever introducing provider-specific logic, custom
  test rigs, direct scripts, or evaluation workflows (for Bedrock, Ollama,
  etc.), **always create brand new files** (such as `OllamaAppRig.tsx` or
  `ollama.eval.ts`) rather than hacking existing Gemini-specific core or test
  structures.
- **Minimal Conflict footprint:** Edits to existing upstream files must be kept
  to an absolute bare minimum. They must be restricted strictly to high-level
  entry points, imports, and short conditional hooks (e.g.
  `if (isOllama) { ... }`) to steer the application toward our custom fork
  files.
- **No Shared Test Pollution:** Do not modify existing Gemini-specific test
  files (such as `AppRig.tsx` or `.eval.ts` files). All live provider
  verification must use new dedicated files.
