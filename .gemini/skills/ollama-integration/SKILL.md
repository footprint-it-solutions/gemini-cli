---
name: ollama-integration
description: "Use this skill when developing, testing, and debugging the Ollama local provider integration within the Gemini CLI. It provides instructions on model settings, tool calling workarounds, schema conversion, and direct programmatic test runners."
---

# Ollama Integration Skill

## Overview

The standard Gemini CLI relies heavily on structured function/tool calling (e.g. `read_file`, `replace`, `glob`, `update_topic`) to interact with files and workspaces. 
However, running local models via Ollama presents two major challenges:
1. **Streaming Tool-Call Failures (Qwen/Llama):** Ollama's streaming parser often fails to correctly serialize streaming tool deltas, leading models to fallback to outputting raw XML-style tags (like `<function=run_shell_command>...`) in conversational text.
2. **Schema Type Incompatibility:** Gemini CLI specifies schemas using uppercase types (`type: "OBJECT"`, `type: "STRING"`), whereas Ollama strictly expects lowercase types (`type: "object"`, `type: "string"`).

This skill provides the operational workflow and automated tests to ensure local Ollama integrations work robustly and regression-free.

---

## Behavior-Driven Development (BDD) Protocol

When modifying or expanding local model support with Ollama, strictly adhere to this BDD cycle:

1. **Define Expected Behavior (Evals):** Prior to making changes, define your expected tool-use or model decisions in a behavioral evaluation file under `/evals/` (e.g., creating an Ollama-specific `.eval.ts` file or test case).
2. **Fail First (Red):** Run `npm run test:all_evals` or target the specific evaluation using `vitest` to observe the tool-calling or format-leakage failure.
3. **Implement & Refactor (Green):** Modify the integration layer (`ollamaProvider.ts`, `ollamaUtils.ts`) or default config alignments in `defaultModelConfigs.ts` to satisfy the test assertions.
4. **Lock-In & Verify:** Confirm that the behavioral test passes 100% locally before checking in.

---

## Technical Specifications & Workarounds

### 1. Schema Sanitization
Ollama requires lowercase types. All tool parameters must be recursively converted before calling Ollama:
```typescript
// Handled by convertSchemaTypesToLowercase in ollamaUtils.ts
{ type: "OBJECT" } -> { type: "object" }
```

### 2. Streaming Bypass for Tool Calls
To avoid the Ollama streaming-parser bugs that leak raw XML tags into the terminal, we bypass streaming whenever tools are present:
```typescript
if (tools && tools.length > 0) {
  // Disable streaming, get complete response, and yield as a single chunk
}
```

### 3. Recommended Local Models
*   **`qwen3-coder:30b` (Highly Recommended):** Mixtral-style MoE, outstanding context window (256K native), natively supports tool use, and fits in standard VRAM (~19GB).
*   **`llama3.1`:** Excellent, smaller option with native tool use. (We map the legacy `llama3` alias to `llama3.1` by default to ensure tool compatibility).

---

## Resources

### `scripts/test_provider_direct.mjs`

An automated ESM script that directly instantiates `OllamaContentGenerator` and drives a full conversational tool call loop. It verifies schema translation, streaming-bypass logic, and that `functionCalls` and tool arguments are returned and parsed successfully.

**Usage:**
```bash
node .gemini/skills/ollama-integration/scripts/test_provider_direct.mjs
```

---

## Workflow

1. Use `/evals/` or `test_provider_direct.mjs` to reproduce Ollama model or tool errors.
2. Edit `ollamaProvider.ts` and `ollamaUtils.ts` to implement necessary corrections.
3. Compile and build using `npm run build -w @google/gemini-cli-core`.
4. Run tests and verify the script outputs `SUCCESS`.
