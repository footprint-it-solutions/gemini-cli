/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VllmContentGenerator } from './vllmProvider.js';
import { LlmRole } from '../../telemetry/llmRole.js';

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation((config) => ({
      baseURL: config?.baseURL,
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            id: 'mock-id',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Hello from mock vLLM!',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        },
      },
    })),
  };
});

describe('VllmContentGenerator', () => {
  let generator: VllmContentGenerator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VLLM_BASE_URL', 'http://localhost:8000/v1');
    vi.stubEnv('VLLM_REMOTE_BASE_URL', 'http://x10srh-1-bm:8000/v1');
    generator = new VllmContentGenerator('fake-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should initialize local and remote clients correctly', () => {
    const localClient = (generator as any).localClient;
    const remoteClient = (generator as any).remoteClient;

    expect(localClient).toBeDefined();
    expect(remoteClient).toBeDefined();

    expect(localClient.baseURL).toBe('http://localhost:8000/v1');
    expect(remoteClient.baseURL).toBe('http://x10srh-1-bm:8000/v1');
  });

  it('should clean model names and select local client for local models', async () => {
    const localCreateSpy = vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    );
    const remoteCreateSpy = vi.spyOn(
      (generator as any).remoteClient.chat.completions,
      'create',
    );

    const result = await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(localCreateSpy).toHaveBeenCalled();
    expect(remoteCreateSpy).not.toHaveBeenCalled();

    // Verify model prefix is stripped
    expect(localCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/gemma-4-12B-it-qat-q4_0-unquantized',
      }),
    );

    expect(result.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'Hello from mock vLLM!',
    );
  });

  it('should select remote client for remote models', async () => {
    const localCreateSpy = vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    );
    const remoteCreateSpy = vi.spyOn(
      (generator as any).remoteClient.chat.completions,
      'create',
    );

    await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-26B-A4B-it',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(localCreateSpy).not.toHaveBeenCalled();
    expect(remoteCreateSpy).toHaveBeenCalled();

    // Verify model prefix is stripped
    expect(remoteCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/gemma-4-12B-it-qat-q4_0-unquantized',
      }),
    );
  });

  it('should select remote client and strip suffix for remote 12B model with -remote in string', async () => {
    const localCreateSpy = vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    );
    const remoteCreateSpy = vi.spyOn(
      (generator as any).remoteClient.chat.completions,
      'create',
    );

    await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-12B-it-remote',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(localCreateSpy).not.toHaveBeenCalled();
    expect(remoteCreateSpy).toHaveBeenCalled();

    // Verify model prefix is stripped and maps to exactly google/gemma-4-12B-it-qat-q4_0-unquantized on the server
    expect(remoteCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/gemma-4-12B-it-qat-q4_0-unquantized',
      }),
    );
  });

  it('should inject thinking instructions into the system prompt when thinkingConfig is active', async () => {
    const localCreateSpy = vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    );

    await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          thinkingConfig: {
            thinkingBudget: 1024,
          },
          systemInstruction: 'You are a coder helper.',
        },
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(localCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining(
              'CRITICAL INSTRUCTION: You must separate your reasoning',
            ),
          }),
        ]),
      }),
    );
  });

  it('should translate XML tags to Gemini JSON parts in streaming mode', async () => {
    const mockChunks = [
      { choices: [{ delta: { content: 'Intro ' } }] },
      { choices: [{ delta: { content: '<thought>' } }] },
      { choices: [{ delta: { content: 'Thinking ' } }] },
      { choices: [{ delta: { content: 'process' } }] },
      { choices: [{ delta: { content: '</thought>' } }] },
      { choices: [{ delta: { content: 'Result is 4.' } }] },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of mockChunks) {
          yield chunk;
        }
      },
    };

    vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    ).mockResolvedValue(mockStream as any);

    const stream = await generator.generateContentStream(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          thinkingConfig: {
            thinkingBudget: 1024,
          },
        },
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    const parts: any[] = [];
    for await (const chunk of stream) {
      const part = chunk.candidates?.[0]?.content?.parts?.[0];
      if (part) {
        parts.push(part);
      }
    }

    // Verify correct segregation of thought and normal text parts
    expect(parts).toEqual([
      { text: 'Intro ' },
      { text: 'Thinking ', thought: true },
      { text: 'process', thought: true },
      { text: 'Result is 4.' },
    ]);
  });

  it('should inject parameter steering instructions into the system prompt when tools are active', async () => {
    const localCreateSpy = vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    );

    await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          tools: [{ functionDeclarations: [{ name: 'write_file' }] }],
          systemInstruction: 'You are a coder helper.',
        },
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    expect(localCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining(
              'CRITICAL INSTRUCTION: You must strictly adhere to the tool schemas and parameter names.',
            ),
          }),
        ]),
      }),
    );
  });

  it('should align path to file_path in non-streaming native tool calls', async () => {
    vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    ).mockResolvedValue({
      id: 'mock-id',
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'test.txt',
                    content: 'hello',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    } as any);

    const result = await generator.generateContent(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          tools: [{ functionDeclarations: [{ name: 'write_file' }] }],
        },
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    const part = result.candidates?.[0]?.content?.parts?.[0];
    expect(part?.functionCall).toBeDefined();
    expect(part?.functionCall?.name).toBe('write_file');
    expect(part?.functionCall?.args).toEqual({
      path: 'test.txt',
      file_path: 'test.txt',
      content: 'hello',
    });
  });

  it('should align path to file_path in streaming native tool calls', async () => {
    const mockChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: 'test.txt',
                      content: 'hello',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of mockChunks) {
          yield chunk;
        }
      },
    };

    vi.spyOn(
      (generator as any).localClient.chat.completions,
      'create',
    ).mockResolvedValue(mockStream as any);

    const stream = await generator.generateContentStream(
      {
        model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          tools: [{ functionDeclarations: [{ name: 'write_file' }] }],
        },
      },
      'prompt-id',
      LlmRole.MAIN,
    );

    const parts: any[] = [];
    for await (const chunk of stream) {
      const part = chunk.candidates?.[0]?.content?.parts?.[0];
      if (part) {
        parts.push(part);
      }
    }

    expect(parts.length).toBe(1);
    expect(parts[0].functionCall).toBeDefined();
    expect(parts[0].functionCall.name).toBe('write_file');
    expect(parts[0].functionCall.args).toEqual({
      path: 'test.txt',
      file_path: 'test.txt',
      content: 'hello',
    });
  });

  it('should parse inline tool calls with nested curly braces and clean trailing characters', () => {
    const rawInlineText = `tool_call>call:write_file{file_path:<|"demo_file.ts<|>",content:<|"export const fn = () => { console.log('ok'); };<|>"}<tool_call|>`;
    const parsed = (generator as any).parseInlineToolCall(rawInlineText);
    expect(parsed).toBeDefined();
    expect(parsed?.name).toBe('write_file');
    expect(parsed?.args).toEqual({
      file_path: 'demo_file.ts',
      content: "export const fn = () => { console.log('ok'); };",
    });
  });

  it('should align parameters for directory-based tools in alignToolArguments', () => {
    const mockArgs = { path: 'src/folder', file_path: 'src/folder' };
    (generator as any).alignToolArguments('list_directory', mockArgs);
    expect(mockArgs).toEqual({
      path: 'src/folder',
      file_path: 'src/folder',
      dir_path: 'src/folder',
    });
  });
});
