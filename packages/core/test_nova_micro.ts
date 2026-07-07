/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BedrockNovaContentGenerator } from './src/core/providers/bedrockNovaProvider.js';

async function run() {
  process.env.AWS_CONFIG_FILE =
    '/home/andrew/repos/footprint-it-solutions/project-aerith/gemini-cli-custom/.aws/config';
  process.env.AWS_PROFILE = 'Aerith-Development';
  process.env.AWS_SDK_LOAD_CONFIG = '1';

  console.log('=== Running Direct Bedrock Nova Micro Test ===');

  // Instantiate generator in Stockholm region (eu-north-1) or eu-west-1
  const generator = new BedrockNovaContentGenerator(
    'eu-west-1',
    'Aerith-Development',
  );

  const request = {
    model: 'bedrock/eu.amazon.nova-micro-v1:0',
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Respond with "Hello World".' }],
      },
    ],
    config: {
      temperature: 0,
      maxOutputTokens: 10,
    },
  };

  try {
    console.log('Calling generateContent for Nova Micro...');
    const response = await generator.generateContent(request);
    console.log(
      'SUCCESS: Response received from Nova Micro:',
      JSON.stringify(response, null, 2),
    );
  } catch (error) {
    console.error('FAIL: Direct Nova Micro invocation failed:', error);
  }
}

run();
