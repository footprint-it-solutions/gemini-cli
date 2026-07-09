/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BedrockNovaAppRig } from '../packages/cli/src/test-utils/BedrockNovaAppRig.js';
import { type EvalPolicy, runEval } from './test-helper.js';
import { BedrockAdjudicator } from './bedrock-judge.js';

/**
 * High-complexity live integration test for Bedrock Nova.
 * Requires AWS credentials to be available in the environment.
 */
export function bedrockStressTest(policy: EvalPolicy) {
  const evalCase = {
    suiteName: 'bedrock-nova-stress',
    suiteType: 'hero-scenario' as const,
    name: 'should successfully complete a minimum 10-turn exhaustive analysis session',
    // We prompt for an extremely detailed, file-by-file analysis to force many turns.
    prompt: [
      'Perform an exhaustive technical audit and improvement cycle for the Ollama Stream provider.',
      'Turn 1: List the directory packages/core/src/core/providers.',
      'Turn 2: Read at least THREE files (ollamaProvider.ts, ollamaStreamingProvider.ts, and ollamaUtils.ts) simultaneously in a single turn using parallel tool calls.',
      'Turn 3: Search AWS Documentation for "Bedrock Nova Converse API streaming best practices" using the MCP server.',
      'Turn 4: Create a new file "ollama-audit.md" with your initial findings from the parallel read.',
      'Turns 5-10: One by one, read the remaining files in the directory and use the "replace" tool to append your updated analysis to "ollama-audit.md".',
      'Do not perform multiple sequential steps in one turn unless specified. Process the deep analysis phase one file per turn.',
      'You must complete at least 10 full turns of interaction and produce a final, high-quality audit file.',
    ].join(' '),
    configOverrides: {
      model: 'bedrock-nova/eu.amazon.nova-2-lite-v1:0',
      approvalMode: 'yolo',
    },
    timeout: 600000, // 10 minutes for a 10-turn session
  };

  const fn = async () => {
    const rig = new BedrockNovaAppRig({
      configOverrides: evalCase.configOverrides,
    });
    const adjudicator = new BedrockAdjudicator();

    try {
      await rig.initialize();
      await rig.render();

      console.log('[Stress Test] Starting 10-turn exhaustive analysis...');
      await rig.sendMessage(evalCase.prompt);

      let turnCount = 0;
      const startTime = Date.now();
      const maxDuration = 540000; // 9 mins

      // Monitor the session and count assistant turns
      while (Date.now() - startTime < maxDuration) {
        const history = rig.getConfig().getHistory();
        const assistantTurns = history.filter((m) => m.role === 'model').length;

        if (assistantTurns !== turnCount) {
          turnCount = assistantTurns;
          console.log(`[Stress Test] Turn ${turnCount} completed...`);
        }

        // Check if the model has provided the final architectural map or signaled completion
        const output = rig.getStaticOutput() || '';
        if (
          output.toLowerCase().includes('architectural map') ||
          output.toLowerCase().includes('analysis complete')
        ) {
          // Ensure we have at least 10 turns before allowing exit
          if (turnCount >= 10) {
            console.log(
              '[Stress Test] Model signaled completion and met turn quota.',
            );
            break;
          }
        }

        // Wait for the next frame
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const finalOutput = rig.getStaticOutput();
      console.log(`[Stress Test] Final Turn Count: ${turnCount}`);

      // Mandatory turn depth check
      expect(
        turnCount,
        'Expected at least 10 conversational turns',
      ).toBeGreaterThanOrEqual(10);

      // --- LLM ADJUDICATION ---
      const audit = await adjudicator.adjudicate(evalCase.prompt, finalOutput);

      if (audit.verdict === 'FAIL') {
        throw new Error(
          `[Stress Test] Adjudicator rejected output!\nREASONING: ${audit.reasoning}\n\nTERMINAL OUTPUT:\n${finalOutput}`,
        );
      }

      console.log('[Stress Test] Adjudicator confirmed success!');
    } finally {
      await rig.unmount();
    }
  };

  runEval(policy, evalCase as any, fn, evalCase.timeout + 20000);
}

// Automatically register if this file is loaded in the eval runner
bedrockStressTest('USUALLY_PASSES');
