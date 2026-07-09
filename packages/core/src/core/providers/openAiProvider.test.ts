/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIContentGenerator } from './openAiProvider.js';
import { LlmRole } from '../../telemetry/llmRole.js';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

describe('OpenAIContentGenerator', () => {
  let generator: OpenAIContentGenerator;
  let mockOpenAI: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new OpenAIContentGenerator('fake-key');
    // @ts-ignore
    mockOpenAI = generator['client'];
  });

  it('should generate content correctly', async () => {
    const mockResponse = {
      id: 'test-id',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello from OpenAI!',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

    const request: any = {
      model: 'gpt-4o',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };

    const response = await generator.generateContent(
      request,
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(response.candidates?.[0].content?.parts?.[0].text).toBe(
      'Hello from OpenAI!',
    );
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    );
  });

  it('should handle system instructions', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      id: 'test-id',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });

    const request: any = {
      model: 'gpt-4o',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      config: {
        systemInstruction: 'You are a bot.',
      },
    };

    await generator.generateContent(request, 'prompt-id', LlmRole.MAIN);

    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are a bot.' },
          { role: 'user', content: 'Hi' },
        ],
      }),
    );
  });

  it('should handle tool calls', async () => {
    const mockResponse = {
      id: 'test-id',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"London"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

    const request: any = {
      model: 'gpt-4o',
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
});
