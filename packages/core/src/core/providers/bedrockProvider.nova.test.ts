/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockContentGenerator } from './bedrockProvider.js';
import type { GenerateContentResponse } from '@google/genai';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { debugLogger } from '../../utils/debugLogger.js';

// Mock the AWS SDK and credential providers
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
    ConverseCommand: vi.fn(),
    ConverseStreamCommand: vi.fn(),
  };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(),
}));

describe('BedrockContentGenerator (Nova Support)', () => {
  let generator: BedrockContentGenerator;
  let mockClient: { send: any };

  beforeEach(() => {
    generator = new BedrockContentGenerator('us-east-1');
    mockClient = (generator as unknown as { client: { send: any } }).client;
  });

  describe('initialization', () => {
    it('should use the provided region and profile', () => {
      new BedrockContentGenerator('us-west-2', 'my-profile');
      expect(fromNodeProviderChain).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: 'my-profile',
        }),
      );
    });
  });

  describe('credential provider logic', () => {
    it('should try standard baseProvider first, and recreate standard provider if it throws', async () => {
      const mockBaseProvider = vi.fn();
      vi.mocked(fromNodeProviderChain).mockReturnValue(mockBaseProvider);

      const { BedrockRuntimeClient } =
        await import('@aws-sdk/client-bedrock-runtime');
      vi.mocked(BedrockRuntimeClient).mockClear();

      const uniqueProfile = `test-profile-${Math.random()}`;
      new BedrockContentGenerator('us-west-2', uniqueProfile);

      // Capture the constructor arguments of BedrockRuntimeClient
      const constructorCalls = vi.mocked(BedrockRuntimeClient).mock.calls;
      expect(constructorCalls.length).toBeGreaterThan(0);
      const passedOptions = constructorCalls[0][0] as any;
      const capturedCredentialsProvider = passedOptions.credentials;

      expect(typeof capturedCredentialsProvider).toBe('function');

      // Setup standard provider to fail on first attempt
      mockBaseProvider.mockRejectedValueOnce(new Error('SSO token expired'));

      // Invoke credentials wrapper. It should fail on standard, call fromNodeProviderChain to re-create standard provider, and throw since fallback fails too
      vi.mocked(fromNodeProviderChain).mockClear();
      try {
        await capturedCredentialsProvider();
      } catch (e) {
        // Expected
      }

      // Check standard provider was re-created after failure
      expect(fromNodeProviderChain).toHaveBeenCalledTimes(1);
    });

    it('should use standard baseProvider successfully on second try without sticky failures', async () => {
      const mockBaseProvider = vi.fn();
      vi.mocked(fromNodeProviderChain).mockReturnValue(mockBaseProvider);

      const { BedrockRuntimeClient } =
        await import('@aws-sdk/client-bedrock-runtime');
      vi.mocked(BedrockRuntimeClient).mockClear();

      const uniqueProfile = `test-profile-${Math.random()}`;
      new BedrockContentGenerator('us-west-2', uniqueProfile);

      const constructorCalls = vi.mocked(BedrockRuntimeClient).mock.calls;
      const passedOptions = constructorCalls[0][0] as any;
      const capturedCredentialsProvider = passedOptions.credentials;

      // First run throws an error (e.g. token expired, before login)
      mockBaseProvider.mockRejectedValueOnce(new Error('SSO token expired'));
      try {
        await capturedCredentialsProvider();
      } catch (e) {
        // Expected
      }

      // Second run succeeds (e.g. user logged in successfully in another terminal)
      const mockCreds = { accessKeyId: 'key', secretAccessKey: 'secret' };
      mockBaseProvider.mockResolvedValue(mockCreds);

      const resolved = await capturedCredentialsProvider();
      expect(resolved).toEqual(mockCreds);
    });
  });

  describe('mapContentsToMessages', () => {
    it('should map user message correctly', () => {
      const contents = [{ role: 'user', parts: [{ text: 'Hello' }] }];
      const messages = (
        generator as unknown as {
          mapContentsToMessages: (c: any, t: boolean) => any;
        }
      ).mapContentsToMessages(contents, true);
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

      const messages = (
        generator as unknown as {
          mapContentsToMessages: (c: any, t: boolean) => any;
        }
      ).mapContentsToMessages(contents, true);

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

    it('should deduplicate duplicate toolResult blocks by toolUseId', () => {
      const contents = [
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

      const messages = (
        generator as unknown as {
          mapContentsToMessages: (c: any, t: boolean) => any;
        }
      ).mapContentsToMessages(contents, true);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toHaveLength(1);
      expect(messages[0].content[0]).toEqual({
        toolResult: {
          toolUseId: 'call_123',
          content: [{ json: { temp: 20 } }],
          status: 'success',
        },
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

      const response = (
        generator as unknown as { mapResponse: (r: any) => any }
      ).mapResponse(bedrockResponse);
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
          candidatesTokenCount: 0,
          promptTokenCount: 0,
          totalTokenCount: 0,
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

      const response = (
        generator as unknown as { mapResponse: (r: any) => any }
      ).mapResponse(bedrockResponse);
      expect((response.candidates as any)[0].content.parts[0]).toEqual({
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
          yield {
            contentBlockStart: {
              start: { toolUse: { toolUseId: 'tool_456', name: 'search' } },
              contentBlockIndex: 0,
            },
          };
          yield {
            contentBlockDelta: {
              delta: { toolUse: { input: '{"que' } },
              contentBlockIndex: 0,
            },
          };
          yield {
            contentBlockDelta: {
              delta: { toolUse: { input: 'ry": "foo"}' } },
              contentBlockIndex: 0,
            },
          };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { messageStop: { stopReason: 'tool_use' } };
        },
      };

      mockClient.send.mockResolvedValue({ stream: mockStream });

      const streamResult = await generator.generateContentStream(
        {
          model: 'bedrock/us.amazon.nova-lite-v1:0',
          contents: [{ role: 'user', parts: [{ text: 'Search for foo' }] }],
        } as any,
        'prompt-123',
        'user' as any,
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of streamResult) {
        chunks.push(chunk);
      }

      // We expect 2 chunks: one with the function call, one with the finish reason
      expect(chunks).toHaveLength(2);
      expect((chunks[0].candidates as any)[0].content.parts[0]).toEqual({
        functionCall: {
          name: 'search',
          args: { query: 'foo' },
          id: 'tool_456',
        },
      });
      expect((chunks[1].candidates as any)[0].finishReason).toBe('STOP');
    });

    it('should log raw unmapped Bedrock stop reasons before mapping to OTHER', async () => {
      const debugSpy = vi
        .spyOn(debugLogger, 'debug')
        .mockImplementation(() => {});
      const warnSpy = vi
        .spyOn(debugLogger, 'warn')
        .mockImplementation(() => {});

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            contentBlockDelta: { delta: { text: 'I will now do the thing:' } },
          };
          yield { messageStop: { stopReason: 'mystery_reason' } };
        },
      };

      mockClient.send.mockResolvedValue({ stream: mockStream });

      const streamResult = await generator.generateContentStream(
        {
          model: 'bedrock/us.amazon.nova-lite-v1:0',
          contents: [{ role: 'user', parts: [{ text: 'Proceed' }] }],
        } as any,
        'prompt-456',
        'user' as any,
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of streamResult) {
        chunks.push(chunk);
      }

      expect((chunks[1].candidates as any)[0].finishReason).toBe('OTHER');
      expect(debugSpy).toHaveBeenCalledWith(
        '[Bedrock Stream] messageStop',
        expect.stringContaining('"stopReason":"mystery_reason"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[Bedrock] Unmapped stopReason received from Bedrock API: 'mystery_reason'. Falling back to 'OTHER'.",
      );
    });
  });
});
