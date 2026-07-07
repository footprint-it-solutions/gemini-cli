/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockNovaContentGenerator } from './bedrockNovaProvider.js';
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

describe('BedrockNovaContentGenerator', () => {
  let generator: BedrockNovaContentGenerator;
  let mockClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new BedrockNovaContentGenerator('us-east-1');
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

    const response = await generator.generateContent(
      request,
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(response.candidates?.[0].content?.parts?.[0].text).toBe(
      'Hello from Bedrock!',
    );
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
    expect(ConverseCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'us.amazon.nova-2-lite-v1:0',
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      }),
    );
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
                parameters: {
                  type: 'object',
                  properties: { location: { type: 'string' } },
                },
              },
            ],
          },
        ],
      },
    };

    const response = await generator.generateContent(
      request as any,
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(
      response.candidates?.[0].content?.parts?.[0].functionCall?.name,
    ).toBe('get_weather');
    expect(
      response.candidates?.[0].content?.parts?.[0].functionCall?.args,
    ).toEqual({ location: 'London' });
  });

  it('should merge consecutive user messages (like multiple tool results) when tools are configured', async () => {
    mockClient.send.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Done!' }],
        },
      },
    });

    const request: any = {
      model: 'us.amazon.nova-2-lite-v1:0',
      contents: [
        { role: 'user', parts: [{ text: 'Run tools' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'tool1', args: {}, id: 'call_1' } },
            { functionCall: { name: 'tool2', args: {}, id: 'call_2' } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool1',
                response: { output: 'res1' },
                id: 'call_1',
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool2',
                response: { output: 'res2' },
                id: 'call_2',
              },
            },
          ],
        },
      ],
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'tool1', description: 'tool 1' },
              { name: 'tool2', description: 'tool 2' },
            ],
          },
        ],
      },
    };

    await generator.generateContent(request, 'prompt-id', LlmRole.MAIN);

    expect(ConverseCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: [{ text: 'Run tools' }] },
          {
            role: 'assistant',
            content: [
              { toolUse: { toolUseId: 'call_1', name: 'tool1', input: {} } },
              { toolUse: { toolUseId: 'call_2', name: 'tool2', input: {} } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'call_1',
                  content: [{ json: { output: 'res1' } }],
                  status: 'success',
                },
              },
              {
                toolResult: {
                  toolUseId: 'call_2',
                  content: [{ json: { output: 'res2' } }],
                  status: 'success',
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it('should inject default fallbacks for the replace tool when arguments are missing', async () => {
    mockClient.send.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'replace_call',
                name: 'replace',
                input: {}, // Empty input
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });

    const request: any = {
      model: 'us.amazon.nova-2-lite-v1:0',
      contents: [{ role: 'user', parts: [{ text: 'Replace text' }] }],
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'replace', description: 'Replace string' },
            ],
          },
        ],
      },
    };

    const response = await generator.generateContent(
      request,
      'prompt-id',
      LlmRole.MAIN,
    );

    const call = response.candidates?.[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe('replace');
    expect(call?.args).toEqual({
      file_path: 'bedrock-fallback.txt',
      instruction: 'Fix file',
      old_string: '',
      new_string: '',
    });
  });

  it('should fix Bedrock Nova dropping base indentation on new_string for replace tool', async () => {
    mockClient.send.mockResolvedValue({
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'replace_call',
                name: 'replace',
                input: {
                  file_path: 'test.go',
                  instruction: 'Fix error block',
                  old_string: '    polly, err := pkgpolly.NewClient(...)',
                  new_string:
                    '    polly, err := pkgpolly.NewClient(...)\nif err != nil {\n    slog.Error(...)\n}',
                },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });

    const request: any = {
      model: 'us.amazon.nova-2-lite-v1:0',
      contents: [{ role: 'user', parts: [{ text: 'Replace text' }] }],
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'replace', description: 'Replace string' },
            ],
          },
        ],
      },
    };

    const response = await generator.generateContent(
      request,
      'prompt-id',
      LlmRole.MAIN,
    );

    const call = response.candidates?.[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe('replace');
    expect(call?.args).toEqual({
      file_path: 'test.go',
      instruction: 'Fix error block',
      old_string: '    polly, err := pkgpolly.NewClient(...)',
      new_string:
        '    polly, err := pkgpolly.NewClient(...)\n    if err != nil {\n        slog.Error(...)\n    }',
    });
  });

  it('should generate content stream and handle metadata correctly', async () => {
    const mockStream = (async function* () {
      yield { contentBlockDelta: { delta: { text: 'Hello' } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield {
        metadata: {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      };
    })();

    mockClient.send.mockResolvedValue({ stream: mockStream });

    const request: any = {
      model: 'us.amazon.nova-2-lite-v1:0',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };

    const stream = await generator.generateContentStream(
      request,
      'prompt-id',
      LlmRole.MAIN,
    );
    const results: any[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(3);
    expect(results[0].candidates?.[0].content?.parts?.[0].text).toBe('Hello');
    expect(results[1].candidates?.[0].finishReason).toBe('STOP');
    expect(results[2].usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    });
  });
});
