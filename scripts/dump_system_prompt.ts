/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '../packages/core/src/config/config.js';
import { getCoreSystemPrompt } from '../packages/core/src/core/prompts.js';
import { BedrockNovaContentGenerator } from '../packages/core/src/core/providers/bedrockNovaProvider.js';
import * as fs from 'node:fs';

async function main() {
  const cwd = process.cwd();
  console.log('Initializing real Config in workspace:', cwd);
  const config = new Config({
    sessionId: 'system-prompt-dump',
    targetDir: cwd,
    cwd,
    debugMode: false,
    model: 'bedrock-nova/eu.amazon.nova-2-lite-v1:0',
  });

  await config.initialize();

  console.log('Generating system instruction from PromptProvider...');
  const systemMemory = config.getSystemInstructionMemory();
  const systemInstruction = getCoreSystemPrompt(config, systemMemory);

  console.log(
    'Instantiating BedrockNovaContentGenerator to apply enhancements...',
  );
  const generator = new BedrockNovaContentGenerator('eu-west-1');

  // We need to construct a sample Converse API-like request structure
  const systemBlock = (
    generator as unknown as {
      mapSystemInstruction: (inst: unknown) => unknown;
    }
  ).mapSystemInstruction({
    parts: [{ text: systemInstruction }],
  });

  // Apply Bedrock anti-looping rules:
  const enhancedSystem = generator['enhanceBedrockSystemPrompt'](systemBlock);

  // Get active tools in Bedrock schema format:
  const tools = config
    .getToolRegistry()
    .getAllTools()
    .map((t) => t.getSchema());

  // Format tool schema into system block:
  const fullyEnrichedSystem = generator['appendToolSchemaHint'](
    enhancedSystem,
    [{ functionDeclarations: tools }],
  );

  const finalPromptText = fullyEnrichedSystem[0].text;

  console.log('System prompt length:', finalPromptText.length, 'characters');

  const outputPath = 'system_prompt.md';
  fs.writeFileSync(outputPath, finalPromptText, 'utf8');
  console.log('SUCCESS: Captured prompt successfully in:', outputPath);
}

main().catch(console.error);
