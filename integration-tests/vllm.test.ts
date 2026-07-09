/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Type } from '@google/genai';
import { VllmContentGenerator } from '../packages/core/src/core/providers/vllmProvider.js';
import { LlmRole } from '../packages/core/src/telemetry/llmRole.js';

// Helper to check if a specific vLLM server is online
async function isUrlOnline(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('vLLM Live Provider Integration Tests', () => {
  const localUrl =
    process.env['VLLM_LOCAL_BASE_URL'] ||
    process.env['VLLM_BASE_URL'] ||
    'http://localhost:8000/v1';
  const remoteUrl =
    process.env['VLLM_REMOTE_BASE_URL'] || 'http://x10srh-1-bm:8000/v1';

  let generator: VllmContentGenerator;

  beforeEach(() => {
    generator = new VllmContentGenerator('vllm-dummy-key');
  });

  it('should successfully interact with local Gemma 4 12B-it on port 8000', async (context) => {
    const online = await isUrlOnline(localUrl);
    if (!online) {
      console.log(
        `[vLLM Integration] Local vLLM is offline at ${localUrl}. Skipping local model integration test.`,
      );
      context.skip();
    }

    console.log(
      `[vLLM Integration] Connecting to local vLLM at ${localUrl}...`,
    );
    const response = await generator.generateContent(
      {
        model: 'gemma4-12b',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Please say the word "Online-Local-Success" and nothing else.',
              },
            ],
          },
        ],
      },
      'test-local-prompt',
      LlmRole.MAIN,
    );

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log(`[vLLM Integration] Local Response: "${text}"`);
    expect(text).toContain('Online-Local-Success');
  });

  it('should successfully interact with remote Gemma 4 12B-it on x10srh-1-bm:8000', async (context) => {
    const online = await isUrlOnline(remoteUrl);
    if (!online) {
      console.log(
        `[vLLM Integration] Remote x10srh-1-bm vLLM is offline at ${remoteUrl}. Skipping remote model integration test.`,
      );
      context.skip();
    }

    console.log(
      `[vLLM Integration] Connecting to remote x10srh-1-bm vLLM at ${remoteUrl}...`,
    );
    const response = await generator.generateContent(
      {
        model: 'gemma4-26b',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Please say the word "Online-Remote-Success" and nothing else.',
              },
            ],
          },
        ],
      },
      'test-remote-prompt',
      LlmRole.MAIN,
    );

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log(`[vLLM Integration] Remote Response: "${text}"`);
    expect(text).toContain('Online-Remote-Success');
  });

  it('should successfully stream responses from the local vLLM instance', async (context) => {
    const online = await isUrlOnline(localUrl);
    if (!online) {
      context.skip();
    }

    const stream = await generator.generateContentStream(
      {
        model: 'gemma4-12b',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Count from 1 to 3.' }],
          },
        ],
      },
      'test-stream-prompt',
      LlmRole.MAIN,
    );

    let streamText = '';
    for await (const chunk of stream) {
      const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
      streamText += chunkText;
    }

    console.log(`[vLLM Integration] Streaming Response: "${streamText}"`);
    expect(streamText).toBeTruthy();
  });

  it('should successfully execute tools on the remote x10srh-1-bm vLLM instance', async (context) => {
    const online = await isUrlOnline(remoteUrl);
    if (!online) {
      context.skip();
    }

    console.log(
      `[vLLM Integration] Sending tool request to remote vLLM at ${remoteUrl}...`,
    );
    const response = await generator.generateContent(
      {
        model: 'gemma4-26b',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Please search AWS documentation tools for cluster creation.',
              },
            ],
          },
        ],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'mcp_awslabs-aws-documentation-mcp-server_search_documentation',
                  description:
                    'Search AWS documentation using the official AWS Documentation Search API.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      search_phrase: {
                        type: Type.STRING,
                        description: 'Query',
                      },
                    },
                    required: ['search_phrase'],
                  },
                },
              ],
            },
          ],
        },
      },
      'test-remote-tool-prompt',
      LlmRole.MAIN,
    );

    const firstCandidate = response.candidates?.[0];
    const functionCalls = firstCandidate?.content?.parts?.filter(
      (p) => p.functionCall,
    );
    console.log(
      '[vLLM Integration] Remote Tool Call Result Parts:',
      JSON.stringify(firstCandidate?.content?.parts),
    );
    expect(functionCalls?.length).toBeGreaterThan(0);
    expect(functionCalls?.[0]?.functionCall?.name).toContain(
      'search_documentation',
    );
  });
});
