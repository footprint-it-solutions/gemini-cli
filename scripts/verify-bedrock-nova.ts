/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * A standalone verification script that runs the real Gemini CLI with Bedrock Nova.
 * This allows the user to observe the 10-turn stress test in real-time.
 */
async function verify() {
  console.log('\n============================================================');
  console.log('BEDROCK NOVA VISUAL VERIFICATION BENCH (ULTIMATE STRESS TEST)');
  console.log('============================================================');
  console.log('Target: 50+ Turn Complex Engineering Session');
  console.log('Model:  bedrock-nova/eu.amazon.nova-2-lite-v1:0');
  console.log('------------------------------------------------------------\n');

  const prompt = [
    'PERFORM A HIGH-COMPLEXITY PROVIDER ENGINEERING SESSION (PHASED EXECUTION).',
    '',
    'PHASE 1: EXHAUSTIVE DISCOVERY (Turns 1-5)',
    '- List all files in packages/core/src/core/providers.',
    '- Parallel read all files matching "provider" or "resolver".',
    '- Identify all hardcoded model names and region-specific logic across these files.',
    '',
    'PHASE 2: MANDATORY DOCUMENTATION DEEP-DIVE (Turns 6-12)',
    '- Perform at least THREE distinct AWS Documentation searches using the MCP server.',
    '- IMPORTANT: Each search must be unique. DO NOT repeat the same query twice.',
    '- Queries to execute:',
    '  1. "Bedrock Converse API Cross-Region Inference best practices"',
    '  2. "Bedrock Nova system prompt block limitations"',
    '  3. "Bedrock tool use stop reason end_turn behavior for streaming"',
    '- Synthesize these findings to identify potential improvements in our BedrockNovaProvider.',
    '',
    'PHASE 3: ARCHITECTURE & SPECIFICATION (Turns 13-18)',
    '- Create a new file "docs/bedrock-nova-standardization.md".',
    '- Document the current mapping logic and propose a high-fidelity refactor based on your research.',
    '- Use Mermaid syntax to map the turn-lifecycle (History -> Mapping -> Stream -> Finalizer).',
    '',
    'PHASE 4: COMPONENT IMPLEMENTATION (Turns 19-35)',
    '- Sequentially create FIVE brand new sample TypeScript source files in "packages/core/src/core/providers/benchmarks/".',
    '- Files: mockProvider.ts, streamFinalizer.ts, regionMapper.ts, authResolver.ts, and UsageTracker.ts.',
    '- Each file must implement a clean, typed provider utility pattern matching the project style.',
    '- CRITICAL: You MUST include the exact comment "// TODO: ADD TEST BOILERPLATE HERE" at the end of each file.',
    '',
    'PHASE 5: ITERATIVE REFACTORING (Turns 36-50)',
    '- Re-read each of the five files created in Phase 4.',
    '- Use the "replace" tool to replace "// TODO: ADD TEST BOILERPLATE HERE" with actual Vitest unit test boilerplate and standardized error handling logic in EACH file.',
    '- Ensure each file includes the Apache-2.0 license header at the top.',
    '- Verify that your "replace" calls succeed (check that lines are added and the file path is correct).',
    '',
    'PHASE 6: PROVIDER HARDENING (Turns 51-60)',
    '- Apply the suggested architectural improvements from Phase 2 to "packages/core/src/core/providers/benchmarks/mockProvider.ts" (NOT the real bedrockNovaProvider.ts).',
    '- Ensure the mock provider is robust against all identified documentation constraints.',
    '- IMPORTANT: Under no circumstances should you modify the real bedrockNovaProvider.ts. All hardening must be performed on your mocked provider.',
    '',
    'DO NOT AGGREGATE PHASES. You must process each step sequentially to ensure a session depth of at least 50 turns. Report your progress at the end of every turn.',
  ].join('\n');

  const args = [
    'bundle/gemini.js',
    prompt,
    '--model',
    'bedrock-nova/eu.amazon.nova-2-lite-v1:0', // Nova Lite as requested
    '--approvalMode',
    'yolo',
  ];

  console.log(
    `Command: node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`,
  );

  // Clean benchmark directory before starting to prevent stale test files from breaking the build
  const fs = await import('node:fs');
  const benchmarkDir = path.resolve(
    rootDir,
    'packages/core/src/core/providers/benchmarks',
  );
  if (fs.existsSync(benchmarkDir)) {
    try {
      fs.rmSync(benchmarkDir, { recursive: true, force: true });
      console.log('[Verification Bench] Cleaned stale benchmark folder.\n');
    } catch {
      // Ignore cleanup error
    }
  }

  const child = spawn('node', args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEBUG_MODE: 'true',
      FORCE_COLOR: '1',
    },
  });

  child.on('error', (err) => {
    console.error('Failed to start CLI process:', err);
    process.exit(1);
  });

  child.on('exit', (code) => {
    // Clean up on exit as well to keep the workspace clean
    if (fs.existsSync(benchmarkDir)) {
      try {
        fs.rmSync(benchmarkDir, { recursive: true, force: true });
        console.log(
          '\n[Verification Bench] Cleaned up temporary benchmark folder.',
        );
      } catch {
        // Ignore exit cleanup error
      }
    }

    console.log(
      '\n------------------------------------------------------------',
    );
    console.log(`Verification Bench exited with code ${code}`);
    console.log(
      '============================================================\n',
    );
    process.exit(code || 0);
  });
}

verify();
