/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockContentGenerator } from './bedrockProvider.js';
import { LlmRole } from '../../telemetry/llmRole.js';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Mock AWS SDK
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
  };
});

describe('BedrockContentGenerator', () => {
  let generator: BedrockContentGenerator;
  let mockClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new BedrockContentGenerator('us-east-1');
    // @ts-ignore
    mockClient = generator['client'];
  });

  it('should generate content correctly', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello from Bedrock!' }],
        },
      },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };

    mockClient.send.mockResolvedValue(mockResponse);

    const request: any = {
      model: 'us.amazon.nova-2-lite-v1:0',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };

    const response = await generator.generateContent(request, 'prompt-id', LlmRole.MAIN);

    expect(response.candidates?.[0].content?.parts?.[0].text).toBe('Hello from Bedrock!');
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
    expect(ConverseCommand).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'us.amazon.nova-2-lite-v1:0',
      messages: [
        { role: 'user', content: [{ text: 'Hi' }] }
      ],
    }));
  });

  it('should handle tool calls', async () => {
      const mockResponse = {
          output: {
              message: {
                  role: 'assistant',
                  content: [
                      {
                          toolUse: {
                              toolUseId: 'call_1',
                              name: 'get_weather',
                              input: { location: 'London' },
                          },
                      },
                  ],
              },
          },
          stopReason: 'tool_use',
      };

      mockClient.send.mockResolvedValue(mockResponse);

      const request: any = {
          model: 'us.amazon.nova-2-lite-v1:0',
          contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
          config: {
              tools: [
                  {
                      functionDeclarations: [
                          {
                              name: 'get_weather',
                              description: 'Get weather',
                              parameters: { type: 'object', properties: { location: { type: 'string' } } },
                          },
                      ],
                  },
              ],
          },
      };

      const response = await generator.generateContent(request as any, 'prompt-id', LlmRole.MAIN);

      expect(response.candidates?.[0].content?.parts?.[0].functionCall?.name).toBe('get_weather');
      expect(response.candidates?.[0].content?.parts?.[0].functionCall?.args).toEqual({ location: 'London' });
  });
});
