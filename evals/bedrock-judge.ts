/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BedrockNovaContentGenerator } from '../packages/core/src/core/providers/bedrockNovaProvider.js';
import { LlmRole } from '@google/gemini-cli-core';

export interface AdjudicationResult {
  verdict: 'PASS' | 'FAIL';
  reasoning: string;
}

/**
 * An independent LLM adjudicator that uses Nova Micro to judge test outputs.
 */
export class BedrockAdjudicator {
  private generator: BedrockNovaContentGenerator;
  private judgeModel = 'eu.amazon.nova-micro-v1:0';

  constructor() {
    this.generator = new BedrockNovaContentGenerator();
  }

  /**
   * Judges whether a test output satisfies the original user prompt.
   */
  async adjudicate(
    originalPrompt: string,
    terminalOutput: string,
  ): Promise<AdjudicationResult> {
    console.log(
      `[Adjudicator] Evaluating test success using ${this.judgeModel}...`,
    );

    const systemPrompt = `You are a strict technical QA auditor. Your goal is to determine if an AI assistant successfully completed a task based on the provided terminal output.

CRITERIA:
1. Did the assistant follow all instructions in the prompt?
2. Did the assistant successfully use tools to gather information?
3. Did the assistant avoid infinite loops, repeated preambles, or premature termination?
4. Is the final answer technically accurate based on the evidence?

You MUST use the 'adjudicate_test' tool to return your verdict.`;

    const userPrompt = `ORIGINAL USER PROMPT:
"""
${originalPrompt}
"""

TERMINAL OUTPUT TO AUDIT:
"""
${terminalOutput}
"""`;

    const adjudicationTool = {
      functionDeclarations: [
        {
          name: 'adjudicate_test',
          description: 'Return the final PASS/FAIL verdict for the test run.',
          parameters: {
            type: 'object',
            properties: {
              verdict: {
                type: 'string',
                enum: ['PASS', 'FAIL'],
                description: 'The binary result of the test.',
              },
              reasoning: {
                type: 'string',
                description:
                  'Detailed explanation of why the test passed or failed.',
              },
            },
            required: ['verdict', 'reasoning'],
          },
        },
      ],
    };

    try {
      const response = await this.generator.generateContent(
        {
          model: `bedrock/${this.judgeModel}`,
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: {
              role: 'system',
              parts: [{ text: systemPrompt }],
            },
            tools: [adjudicationTool],
          },
        },
        'adjudication-turn',
        LlmRole.UTILITY_TOOL,
      );

      const call = response.functionCalls?.[0];
      if (call && call.name === 'adjudicate_test') {
        const result = call.args as AdjudicationResult;
        console.log(`[Adjudicator] VERDICT: ${result.verdict}`);
        console.log(`[Adjudicator] REASONING: ${result.reasoning}`);
        return result;
      }

      throw new Error('Adjudicator failed to call the adjudication tool.');
    } catch (error: any) {
      console.error('[Adjudicator] Error during adjudication:', error.message);
      return {
        verdict: 'FAIL',
        reasoning: `Adjudicator error: ${error.message}`,
      };
    }
  }
}
