# System prompt debugging

Gemini CLI constructs its system instructions dynamically by merging core rules,
user context, activated skills, and available tools. To facilitate prompt
engineering and debugging, you can extract the exact compiled prompt sent to the
LLM providers.

This guide explains how to dump the compiled system prompt and inspect the raw
instructions that govern the agent's behavior.

## Dump the active system prompt

The repository contains a utility script, `scripts/dump_system_prompt.ts`, that
lets you compile and save the full active system prompt to a local Markdown
file.

To dump the system prompt, perform the following steps:

1. Compile the project packages:

   ```bash
   npm run build
   ```

2. Execute the extraction script using `tsx`:

   ```bash
   npx tsx scripts/dump_system_prompt.ts
   ```

The script initializes the active project configuration, registers all available
workspace tools, loads context from `GEMINI.md` files, and applies
Bedrock-specific anti-looping rules. It then outputs the finalized compiled text
directly to `system_prompt.md` in your workspace root.

<!-- prettier-ignore -->
> [!NOTE]
> The generated prompt size can vary depending on which workspace files are
> loaded, what tools are registered, and whether active agent skills are
> appended to the context.
