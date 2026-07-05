# Bedrock Integration & pnpm Migration Plan

This plan outlines the steps to migrate `gemini-cli-bedrock` to `pnpm` for total
environment isolation and to verify the AWS Bedrock integration in a "Clean
Room" state.

## Phase 1: Environment Isolation (The "Virtualenv" equivalent)

1.  **pnpm Initialization:** Run `pnpm install` in the project root to generate
    a strict, non-flat dependency tree. This prevents "phantom dependencies" and
    cross-contamination.
2.  **Workspace Build:** Run `pnpm run build` to compile all packages (`core`,
    `cli`, `devtools`, etc.) using the isolated `pnpm` environment.
3.  **Bundle Generation:** Run `pnpm run bundle` to create the unified
    `bundle/gemini.js` executable.

## Phase 2: Functional Verification

1.  **Sanity Check (Non-Interactive):** Verify basic Bedrock connectivity and
    model resolution using `pnpm exec node bundle/gemini.js`.
2.  **Closed-Loop Interactive Test:** Run the `scripts/verify-interactive.js`
    script using `pnpm exec` to confirm that the TUI logic, role merging, and
    tool mapping are stable in the new environment.
3.  **Manual TUI Validation:** Perform a live interactive session with
    `GEMINI_CLI_HOME` redirected to `.gemini-isolated` to ensure total isolation
    from system settings.

## Phase 3: Hardening & Finalization

1.  **AWS Profile Resilience:** Confirm that `AWS_PROFILE` and `--aws-profile`
    are correctly picked up across turns.
2.  **Error Handling Audit:** Ensure any remaining "Unknown API Errors" are
    caught by the new robust error parsing and display descriptive AWS messages.
3.  **Model ID Consistency:** Final check that `nova-lite` and `nova-pro`
    resolve to the expected `eu-west-1` region and `eu.` inference profile
    prefixes.

## Verification Commands

```bash
# 1. Initialize and Build
pnpm install
pnpm run build && pnpm run bundle

# 2. Test Non-Interactive
pnpm exec node bundle/gemini.js --model bedrock/nova-lite -p "Hello Bedrock, confirm your model and region."

## Bedrock Reliability TODO

- [ ] Expand `BedrockTurnState` observability with counters/tracing for repeated stranded turns.
- [ ] Evaluate whether the Nova Micro uncertain-turn classifier should move fully to a client-side pseudo-tool contract in production.
- [ ] Investigate a Bedrock control-plane pseudo-tool for primary assistant turns (`continue | ask_user | done`) without disturbing normal work tools.

# 3. Test Interactive (Automated)
VERBOSE=true pnpm exec node scripts/verify-interactive.js

# 4. Run TUI (Manual)
GEMINI_CLI_HOME=$(pwd)/.gemini-isolated pnpm exec node bundle/gemini.js --model bedrock/nova-lite
```
