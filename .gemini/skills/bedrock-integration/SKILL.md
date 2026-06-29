---
name: bedrock-integration
description: "Use this skill when developing, testing, and debugging the Bedrock Nova provider integration within the Gemini CLI Bedrock fork. It provides an automated programmatic test runner for simulating interactive tool calls without manual user intervention."
---

# Bedrock Integration Skill

## Overview

The `gemini-cli-bedrock` project aims to achieve parity with the standard Google Gemini engine, using Amazon Bedrock Nova models as a drop-in replacement.
However, because the core `gemini.js` engine relies on strict JSON schema validation for all tool calls, Bedrock Nova sometimes fails to adhere to these schemas (e.g. omitting required arguments like `strategic_intent` for `update_topic`, or returning `{}` for `write_file`). 

This skill provides a self-contained test environment for automatically verifying whether the Bedrock tool calling loop works. This allows the AI agent to iteratively debug and patch the `bedrockProvider.ts` abstraction layer independently, without requiring the user to act as an intermediary tester.

## Resources

### `scripts/test_provider_direct.mjs`

An automated ESM script that directly instantiates `BedrockContentGenerator` and drives a full multi-turn conversational tool call loop. This is the most reliable way to test the Bedrock integration because it completely avoids TTY/PTY allocation issues.

**Usage:**
```bash
pnpm exec node .gemini/skills/bedrock-integration/scripts/test_provider_direct.mjs
```
This script will:
1. Direct-call `BedrockContentGenerator` with `write_file` and `update_topic` tool definitions.
2. Verify that Bedrock's streamed tool call (`generateContentStream`) correctly aggregates chunked payloads into the root `functionCalls` array.
3. Verify that the tool arguments (e.g. `file_path` and `content`) are fully populated and not empty `{}`.
4. Simulate feeding the tool result back as a subsequent history turn to verify that Bedrock successfully processes the `toolResult` sequence without throwing an `Expected toolResult blocks` exception.

### `scripts/test_interactive.cjs`

An automated legacy script that runs the Gemini CLI in interactive mode (using `child_process.spawn`) by passing a prompt and verifying if tools like `write_file` are successfully executed. (Requires a TTY/PTY simulation to bypass headless mode fallback).

## Workflow

1. Use `test_interactive.cjs` to simulate an interactive session and surface tool errors.
2. Read `bedrockProvider.ts` to map and parse exactly what Nova generates.
3. Patch `mapStreamResponse` and `mapResponse` as an active "translation layer" that intercepts Nova's tool payloads and forcibly injects required defaults/formats BEFORE the engine validates them.
4. Rebuild the core `pnpm --filter @google/gemini-cli-core build && pnpm run bundle`.
5. Iterate until `test_interactive.cjs` returns a SUCCESS block.
