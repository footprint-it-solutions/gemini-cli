/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockNovaContentGenerator } from './bedrockNovaProvider.js';
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

describe('BedrockNovaContentGenerator (Nova Support)', () => {
  let generator: BedrockNovaContentGenerator;
  let mockClient: { send: any };

  beforeEach(() => {
    generator = new BedrockNovaContentGenerator('us-east-1');
    mockClient = (generator as unknown as { client: { send: any } }).client;
  });

  describe('initialization', () => {
    it('should use the provided region and profile', () => {
      new BedrockNovaContentGenerator('us-west-2', 'my-profile');
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
      new BedrockNovaContentGenerator('us-west-2', uniqueProfile);

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
      new BedrockNovaContentGenerator('us-west-2', uniqueProfile);

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

    it('should serialize historical tool calls and results as text when no tools are configured', () => {
      const contents = [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { file_path: 'src/app.ts', start_line: 1, end_line: 20 },
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
                name: 'read_file',
                response: { output: 'file contents' },
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
      ).mapContentsToMessages(contents, false);

      expect(messages).toEqual([
        {
          role: 'assistant',
          content: [
            {
              text: '[Tool Call] read_file {"file_path":"src/app.ts","start_line":1,"end_line":20}',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              text: '[Tool Result] read_file: {"output":"file contents"}',
            },
          ],
        },
      ]);
    });

    it('should add Bedrock-specific guidance to the read_file tool description', () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: 'Reads a file.',
              parameters: { properties: {} },
            },
          ],
        },
      ];

      const toolConfig = (
        generator as unknown as { mapTools: (tools: any[] | undefined) => any }
      ).mapTools(tools);

      expect(toolConfig.tools[0].toolSpec.description).toContain(
        'prefer a single full-file read without start_line or end_line',
      );
      expect(toolConfig.tools[0].toolSpec.description).toContain(
        'prefer broader targeted ranges or parallel reads over many tiny sequential range reads',
      );
    });

    it('should add Bedrock-specific guidance to the read_many_files tool description', () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'read_many_files',
              description: 'Reads many files.',
              parameters: { properties: {} },
            },
          ],
        },
      ];

      const toolConfig = (
        generator as unknown as { mapTools: (tools: any[] | undefined) => any }
      ).mapTools(tools);

      expect(toolConfig.tools[0].toolSpec.description).toContain(
        'prefer this tool for repository overviews, broad codebase analysis, and reading multiple related files',
      );
    });
  });

  describe('appendToolHint', () => {
    it('should strip Explain Before Acting style pre-tool narration mandates for Bedrock', () => {
      const system = [
        {
          text: `- **Explain Before Acting:** Never call tools in silence. You MUST provide a concise, one-sentence explanation of your intent or strategy immediately before executing tool calls.\n- **No Chitchat:** Avoid conversational filler, preambles ("Okay, I will now..."), or postambles ("I have finished the changes...") unless they are part of the 'Explain Before Acting' mandate.\n- **Explain Critical Commands:** Before executing commands with \`run_shell_command\` that modify the file system, codebase, or system state, you *must* provide a brief explanation of the command's purpose and potential impact. You MUST NOT use \`ask_user\` to ask for permission to run a command.`,
        },
      ];

      const result = (
        generator as unknown as {
          appendToolHint: (
            system: Array<{ text: string }>,
          ) => Array<{ text: string }>;
        }
      ).appendToolHint(system);

      expect(result[0].text).not.toContain('Explain Before Acting');
      expect(result[0].text).not.toContain('No Chitchat');
      expect(result[0].text).not.toContain('Explain Critical Commands');
      expect(result.at(-1)?.text).toContain('STRUCTURED OUTPUT CONTRACT');
      expect(result.at(-1)?.text).toContain(
        'avoid interim narration like "let me keep reading"',
      );
      expect(result.at(-1)?.text).toContain(
        "prefer a single full-file 'read_file' call without line bounds",
      );
      expect(result.at(-1)?.text).toContain(
        "prefer 'read_many_files' over a long series of one-file or one-slice reads",
      );
      expect(result.at(-1)?.text).toContain(
        'If you need to provide code in assistant text, start with the code immediately.',
      );
      expect(result.at(-1)?.text).toContain(
        'prefer modifying files with tools instead of pasting long replacement code into chat',
      );
    });

    it('should add structured output instructions even when there is no existing system prompt', () => {
      const tools = {
        tools: [
          {
            toolSpec: {
              name: 'classify_bedrock_turn',
              description: 'Classify the turn',
              inputSchema: {
                json: {
                  type: 'object',
                  properties: {
                    decision: { type: 'string' },
                    confidence: { type: 'string' },
                  },
                  required: ['decision'],
                },
              },
            },
          },
        ],
      };

      const result = (
        generator as unknown as {
          appendToolHint: (
            system: Array<{ text: string }> | undefined,
            toolConfig?: unknown,
          ) => Array<{ text: string }>;
        }
      ).appendToolHint(undefined, tools);

      expect(result).toHaveLength(1);
      expect(result[0].text).toContain('STRUCTURED OUTPUT CONTRACT');
      expect(result[0].text).toContain('classify_bedrock_turn');
      expect(result[0].text).toContain('properties: decision, confidence');
      expect(result[0].text).toContain('required: decision');
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
      expect(response).toMatchObject({
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

    it('should preserve multiple assistant text blocks and attach Bedrock turn-state metadata', () => {
      const bedrockResponse = {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'First block.' }, { text: 'Second block:' }],
          },
        },
        stopReason: 'end_turn',
      };

      const response = (
        generator as unknown as { mapResponse: (r: any) => any }
      ).mapResponse(bedrockResponse);

      expect((response.candidates as any)[0].content.parts).toEqual([
        { text: 'First block.' },
        { text: 'Second block:' },
      ]);
      expect((response as any).metadata.bedrockTurnState).toMatchObject({
        isStreaming: false,
        rawStopReason: 'end_turn',
        responseText: 'First block. Second block:',
        emittedToolCallCount: 0,
        stream: {
          sawAssistantText: true,
          emittedAssistantTextBlockCount: 2,
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
        'turn-456',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of streamResult) {
        chunks.push(chunk);
      }

      expect((chunks[1].candidates as any)[0].finishReason).toBe('OTHER');
      expect(chunks[0].responseId).toBe('turn-456');
      expect(chunks[1].responseId).toBe('turn-456');
      expect(debugSpy).toHaveBeenCalledWith(
        '[Bedrock Stream] messageStop',
        expect.stringContaining('"turnId":"turn-456"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[Bedrock] Unmapped stopReason received from Bedrock API: 'mystery_reason'. Falling back to 'OTHER'.",
      );
      expect((chunks[1] as any).metadata.bedrockTurnState).toMatchObject({
        isStreaming: true,
        rawStopReason: 'mystery_reason',
        responseText: 'I will now do the thing:',
        stream: {
          sawAssistantText: true,
          sawContentBlockStop: false,
          emittedAssistantTextBlockCount: 1,
        },
      });
    });
  });
});
