/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaContentGenerator } from './ollamaProvider.js';
import { LlmRole } from '../../telemetry/llmRole.js';

// Mock Ollama
vi.mock('ollama', () => {
  return {
    Ollama: vi.fn().mockImplementation(() => ({
      chat: vi.fn(),
      embeddings: vi.fn(),
    })),
  };
});

describe('OllamaContentGenerator', () => {
  let generator: OllamaContentGenerator;
  let mockClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new OllamaContentGenerator('http://localhost:11434');
    // @ts-ignore
    mockClient = generator['client'];
  });

  it('should generate content correctly', async () => {
    const mockResponse = {
      message: {
        role: 'assistant',
        content: 'Hello from Ollama!',
      },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };

    mockClient.chat.mockResolvedValue(mockResponse);

    const request: any = {
      model: 'llama3',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };

    const response = await generator.generateContent(request, 'prompt-id', LlmRole.MAIN);

    expect(response.candidates?.[0].content?.parts?.[0].text).toBe('Hello from Ollama!');
    expect(response.usageMetadata?.totalTokenCount).toBe(15);
    expect(mockClient.chat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'llama3',
      messages: [
        { role: 'user', content: 'Hi' }
      ],
    }));
  });

  it('should handle tool calls', async () => {
      const mockResponse = {
          message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                  {
                      function: {
                          name: 'get_weather',
                          arguments: { location: 'London' },
                      },
                  },
              ],
          },
          done: true,
      };

      mockClient.chat.mockResolvedValue(mockResponse);

      const request: any = {
          model: 'llama3',
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
