/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaContentGenerator } from './ollamaProvider.js';
import { LlmRole } from '../../telemetry/llmRole.js';

// Mock OpenAI (used by Ollama)
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

describe('OllamaContentGenerator', () => {
  let generator: OllamaContentGenerator;
  let mockOpenAI: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    generator = new OllamaContentGenerator('http://localhost:11434/v1');
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
            content: 'Hello from Ollama!',
          },
          finish_reason: 'stop',
        },
      ],
    };

    mockOpenAI.chat.completions.create.mockResolvedValue(mockResponse);

    const request = {
      model: 'llama3',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    };

    const response = await generator.generateContent(request, 'prompt-id', LlmRole.MAIN);

    expect(response.candidates?.[0].content?.parts?.[0].text).toBe('Hello from Ollama!');
  });
});
