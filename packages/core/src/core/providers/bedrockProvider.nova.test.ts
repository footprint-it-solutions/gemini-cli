/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockContentGenerator } from './bedrockProvider.js';
import type { GenerateContentResponse } from '@google/genai';

// Mock the AWS SDK
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
  };
});

describe('BedrockContentGenerator (Nova Support)', () => {
  let generator: BedrockContentGenerator;
  let mockClient: { send: any };

  beforeEach(() => {
    generator = new BedrockContentGenerator({
      modelId: 'us.amazon.nova-lite-v1:0',
      region: 'us-east-1',
    });
    mockClient = (generator as unknown as { client: { send: any } }).client;
  });

  describe('mapContentsToMessages', () => {
    it('should map user message correctly', () => {
      const contents = [{ role: 'user', parts: [{ text: 'Hello' }] }];
      const messages = (generator as unknown as { mapContentsToMessages: (c: any) => any }).mapContentsToMessages(contents);
      expect(messages).toEqual([
        { role: 'user', content: [{ text: 'Hello' }] },
      ]);
    });

    it('should map tool call and response correctly (Nova parity)', () => {
      const contents = [
        { role: 'user', parts: [{ text: 'What is the weather?' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: { location: 'London' },
                id: 'call_123',
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_weather',
                response: { temp: 20 },
                id: 'call_123',
              },
            },
          ],
        },
      ];

      const messages = (generator as unknown as { mapContentsToMessages: (c: any) => any }).mapContentsToMessages(contents);

      expect(messages).toHaveLength(3);
      // Assistant turn with tool use
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'call_123',
              name: 'get_weather',
              input: { location: 'London' },
            },
          },
        ],
      });
      // User turn with tool result
      expect(messages[2]).toEqual({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call_123',
              content: [{ json: { temp: 20 } }],
              status: 'success',
            },
          },
        ],
      });
    });
  });

  describe('mapResponse', () => {
    it('should map Bedrock response to Gemini format', () => {
      const bedrockResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'The weather is 20 degrees.' }],
          },
        },
        stopReason: 'end_turn',
      };

      const response = (generator as unknown as { mapResponse: (r: any) => any }).mapResponse(bedrockResponse);
      expect(response).toEqual({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'The weather is 20 degrees.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          candidatesTokenCount: undefined,
          promptTokenCount: undefined,
          totalTokenCount: undefined,
        },
      });
    });

    it('should map Bedrock tool use response to Gemini format', () => {
      const bedrockResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 'tool_123',
                  name: 'get_weather',
                  input: { location: 'Paris' },
                },
              },
            ],
          },
        },
        stopReason: 'tool_use',
      };

      const response = (generator as unknown as { mapResponse: (r: any) => any }).mapResponse(bedrockResponse);
      expect(response.candidates[0].content.parts[0]).toEqual({
        functionCall: {
          name: 'get_weather',
          args: { location: 'Paris' },
          id: 'tool_123',
        },
      });
    });
  });

  describe('generateContentStream', () => {
    it('should handle streaming tool calls (accumulated deltas)', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield { messageStart: { role: 'assistant' } };
          yield { contentBlockStart: { start: { toolUse: { toolUseId: 'tool_456', name: 'search' } }, contentBlockIndex: 0 } };
          yield { contentBlockDelta: { delta: { toolUse: { input: '{"que' } }, contentBlockIndex: 0 } };
          yield { contentBlockDelta: { delta: { toolUse: { input: 'ry": "foo"}' } }, contentBlockIndex: 0 } };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'tool_use' } };
        },
      };

      mockClient.send.mockResolvedValue({ stream: mockStream });

      const streamResult = await generator.generateContentStream({
        model: 'bedrock/us.amazon.nova-lite-v1:0',
        contents: [{ role: 'user', parts: [{ text: 'Search for foo' }] }],
      } as any, 'prompt-123', 'user' as any);

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of streamResult) {
        chunks.push(chunk);
      }

      // We expect 2 chunks: one with the function call, one with the finish reason
      expect(chunks).toHaveLength(2);
      expect(chunks[0].candidates[0].content.parts[0]).toEqual({
        functionCall: {
          name: 'search',
          args: { query: 'foo' },
          id: 'tool_456',
        },
      });
      expect(chunks[1].candidates[0].finishReason).toBe('STOP');
    });
  });
});
