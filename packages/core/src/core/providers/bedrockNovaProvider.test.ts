/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockNovaContentGenerator,
  unescapePartialString,
  parsePartialResponse,
} from './bedrockNovaProvider.js';
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

describe('BedrockNovaContentGenerator - Core Utilities', () => {
  describe('unescapePartialString', () => {
    it('should decode standard escapes correctly', () => {
      expect(unescapePartialString('hello\\nworld')).toBe('hello\nworld');
      expect(unescapePartialString('hello\\tworld')).toBe('hello\tworld');
      expect(unescapePartialString('he said \\"hi\\"')).toBe('he said "hi"');
      expect(unescapePartialString('slash\\\\slash')).toBe('slash\\slash');
    });

    it('should handle incomplete or trailing backslashes gracefully', () => {
      expect(unescapePartialString('hello\\')).toBe('hello');
    });
  });

  describe('parsePartialResponse', () => {
    it('should parse partial outputs before text is generated', () => {
      const partial1 = '{"thoughts":"I am planning';
      const result1 = parsePartialResponse(partial1);
      expect(result1.thoughts).toBe('I am planning');
      expect(result1.text).toBe('');
    });

    it('should parse outputs when thoughts are closed but text is open', () => {
      const partial2 = '{"thoughts":"Searching for files.","text":"I will find';
      const result2 = parsePartialResponse(partial2);
      expect(result2.thoughts).toBe('Searching for files.');
      expect(result2.text).toBe('I will find');
    });

    it('should parse outputs when both thoughts and text are fully closed', () => {
      const partial3 =
        '{"thoughts":"Searching for files.","text":"I will find files.","tool_calls":[]';
      const result3 = parsePartialResponse(partial3);
      expect(result3.thoughts).toBe('Searching for files.');
      expect(result3.text).toBe('I will find files.');
    });

    it('should handle JSON escape sequences in partial parses', () => {
      const partial =
        '{"thoughts":"Planning\\nstep 1","text":"Sure! \\"Path\\": \\\\usr';
      const result = parsePartialResponse(partial);
      expect(result.thoughts).toBe('Planning\nstep 1');
      expect(result.text).toBe('Sure! "Path": \\usr');
    });
  });
});

describe('BedrockNovaContentGenerator - Content Generator', () => {
  let generator: BedrockNovaContentGenerator;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    generator = new BedrockNovaContentGenerator('us-east-1');
    // @ts-ignore
    mockClient = generator['client'];
  });

  it('should construct request forcing nova_response_schema and parse response', async () => {
    const mockResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId: 'call_nova_123',
                name: 'nova_response_schema',
                input: {
                  thoughts: 'I should read the file.',
                  text: 'Reading file package.json...',
                  tool_calls: [
                    {
                      name: 'read_file',
                      arguments_json: '{"file_path":"package.json"}',
                    },
                  ],
                },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    };

    mockClient.send.mockResolvedValue(mockResponse);

    const request: any = {
      model: 'bedrock-nova/us.amazon.nova-2-lite-v1:0',
      contents: [
        { role: 'user', parts: [{ text: 'Check project dependencies' }] },
      ],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'Read file',
                parameters: {
                  type: 'object',
                  properties: { file_path: { type: 'string' } },
                  required: ['file_path'],
                },
              },
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

    // Verify thoughts, text, and nested tool calls are reconstructed
    expect(response.candidates?.[0].content?.parts?.[0]).toEqual({
      text: 'I should read the file.',
      thought: true,
    });
    expect(response.candidates?.[0].content?.parts?.[1]).toEqual({
      text: 'Reading file package.json...',
    });
    expect(response.candidates?.[0].content?.parts?.[2].functionCall).toEqual({
      id: 'call_nova_123_0',
      name: 'read_file',
      args: { file_path: 'package.json' },
    });

    expect(response.functionCalls?.[0]).toEqual({
      id: 'call_nova_123_0',
      name: 'read_file',
      args: { file_path: 'package.json' },
    });

    // Verify ConverseCommand payload
    expect(ConverseCommand).toHaveBeenCalled();
    const callArgs = (ConverseCommand as any).mock.calls[0][0];
    expect(callArgs.modelId).toBe('us.amazon.nova-2-lite-v1:0');
    expect(callArgs.toolConfig.toolChoice).toEqual({
      tool: { name: 'nova_response_schema' },
    });
    expect(callArgs.toolConfig.tools[0].toolSpec.name).toBe(
      'nova_response_schema',
    );
    expect(callArgs.system[0].text).toContain('AVAILABLE WORKSPACE TOOLS');
    expect(callArgs.system[0].text).toContain('read_file');
  });

  it('should map conversational history correctly to Nova forced formats', () => {
    const contents: any[] = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_xxx',
              name: 'glob',
              args: { pattern: '*.json' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_xxx',
              name: 'glob',
              response: ['package.json'],
            },
          },
        ],
      },
    ];

    // @ts-ignore
    const mappedMessages = generator.mapContentsToMessages(contents);

    expect(mappedMessages.length).toBe(3);

    // Turn 1 (user): normal text
    expect(mappedMessages[0].role).toBe('user');
    expect(mappedMessages[0].content?.[0]).toEqual({ text: 'Hello' });

    // Turn 2 (assistant): toolUse of nova_response_schema embedding glob
    expect(mappedMessages[1].role).toBe('assistant');
    const toolUseBlock = mappedMessages[1].content?.[0] as any;
    expect(toolUseBlock.toolUse.name).toBe('nova_response_schema');
    expect(toolUseBlock.toolUse.toolUseId).toBe('call_xxx');
    expect(toolUseBlock.toolUse.input.tool_calls[0].name).toBe('glob');
    expect(toolUseBlock.toolUse.input.tool_calls[0].arguments_json).toBe(
      '{"pattern":"*.json"}',
    );

    // Turn 3 (user): toolResult of nova_response_schema wrapping glob output
    expect(mappedMessages[2].role).toBe('user');
    const toolResultBlock = mappedMessages[2].content?.[0] as any;
    expect(toolResultBlock.toolResult.toolUseId).toBe('call_xxx');
    expect(toolResultBlock.toolResult.status).toBe('success');
    const parsedTextResult = JSON.parse(
      toolResultBlock.toolResult.content[0].text,
    );
    expect(parsedTextResult.tool_name).toBe('glob');
    expect(parsedTextResult.result).toEqual(['package.json']);
  });

  it('should map parallel tool calls and responses into unified schema blocks', () => {
    const contents: any[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'parallel_call',
              name: 'read_file',
              args: { file_path: 'a.ts' },
            },
          },
          {
            functionCall: {
              id: 'parallel_call',
              name: 'read_file',
              args: { file_path: 'b.ts' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'parallel_call',
              name: 'read_file',
              response: { content: 'A' },
            },
          },
          {
            functionResponse: {
              id: 'parallel_call',
              name: 'read_file',
              response: { content: 'B' },
            },
          },
        ],
      },
    ];

    // @ts-ignore
    const mappedMessages = generator.mapContentsToMessages(contents);

    expect(mappedMessages.length).toBe(2);

    // Turn 1 (model): exactly ONE toolUse block wrapping both tool calls
    expect(mappedMessages[0].role).toBe('assistant');
    expect(mappedMessages[0].content?.length).toBe(1);
    const toolUseBlock = mappedMessages[0].content?.[0] as any;
    expect(toolUseBlock.toolUse.name).toBe('nova_response_schema');
    expect(toolUseBlock.toolUse.input.tool_calls.length).toBe(2);
    expect(toolUseBlock.toolUse.input.tool_calls[0].name).toBe('read_file');
    expect(toolUseBlock.toolUse.input.tool_calls[1].name).toBe('read_file');

    // Turn 2 (user): exactly ONE toolResult block wrapping both outputs as an array
    expect(mappedMessages[1].role).toBe('user');
    expect(mappedMessages[1].content?.length).toBe(1);
    const toolResultBlock = mappedMessages[1].content?.[0] as any;
    expect(toolResultBlock.toolResult.status).toBe('success');
    const parsedTextResults = JSON.parse(
      toolResultBlock.toolResult.content[0].text,
    );
    expect(Array.isArray(parsedTextResults)).toBe(true);
    expect(parsedTextResults.length).toBe(2);
    expect(parsedTextResults[0].tool_name).toBe('read_file');
    expect(parsedTextResults[0].result).toEqual({ content: 'A' });
    expect(parsedTextResults[1].tool_name).toBe('read_file');
    expect(parsedTextResults[1].result).toEqual({ content: 'B' });
  });

  it('REPRO: should map conversational history where a model turn has no tools but user has a follow-up text prompt', () => {
    const contents: any[] = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
      {
        role: 'model',
        parts: [
          {
            text: 'I found files.',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            text: 'Awesome, please read them',
          },
        ],
      },
    ];

    // @ts-ignore
    const mappedMessages = generator.mapContentsToMessages(contents);

    expect(mappedMessages.length).toBe(3);

    // Turn 1 (user): text
    expect(mappedMessages[0].role).toBe('user');
    expect(mappedMessages[0].content?.[0]).toEqual({ text: 'Hello' });

    // Turn 2 (assistant): toolUse of nova_response_schema with tooluse_synthetic
    expect(mappedMessages[1].role).toBe('assistant');
    const assistantToolUse = mappedMessages[1].content?.[0] as any;
    expect(assistantToolUse.toolUse.name).toBe('nova_response_schema');
    expect(assistantToolUse.toolUse.toolUseId).toBe('tooluse_synthetic');

    // Turn 3 (user): MUST contain both the text and a toolResult block for tooluse_synthetic to satisfy Bedrock!
    expect(mappedMessages[2].role).toBe('user');
    expect(
      mappedMessages[2].content?.some(
        (block: any) => block.text === 'Awesome, please read them',
      ),
    ).toBe(true);
    expect(
      mappedMessages[2].content?.some(
        (block: any) => block.toolResult?.toolUseId === 'tooluse_synthetic',
      ),
    ).toBe(true);
  });

  it('REPRO: should NOT duplicate toolResult blocks with the same ID when there are consecutive user turns', () => {
    const contents: any[] = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
      {
        role: 'model',
        parts: [
          {
            text: 'I found files.',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            text: 'Consecutive segment 1',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            text: 'Consecutive segment 2',
          },
        ],
      },
    ];

    // @ts-ignore
    const mappedMessages = generator.mapContentsToMessages(contents);

    // Consecutive user turns are coalesced into a single Message under role 'user'
    expect(mappedMessages.length).toBe(3);

    expect(mappedMessages[0].role).toBe('user');
    expect(mappedMessages[1].role).toBe('assistant');
    expect(mappedMessages[2].role).toBe('user');

    const lastUserMessage = mappedMessages[2];
    const toolResults =
      lastUserMessage.content?.filter((block: any) => block.toolResult) || [];

    // There MUST be exactly one toolResult block for 'tooluse_synthetic'
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.toolResult?.toolUseId).toBe('tooluse_synthetic');
  });

  it('REPRO: should correctly align toolUseId and toolResultId even if there is a prefix mismatch', () => {
    const contents: any[] = [
      {
        role: 'user',
        parts: [{ text: 'Hello' }],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'mcp_git_git_status__tooluse_KfDgpsRapEXpRCT6klvI8d_0',
              name: 'mcp_git_git_status',
              args: {},
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tooluse_KfDgpsRapEXpRCT6klvI8d_0',
              name: 'mcp_git_git_status',
              response: { success: true },
            },
          },
        ],
      },
    ];

    // @ts-ignore
    const mappedMessages = generator.mapContentsToMessages(contents);

    expect(mappedMessages.length).toBe(3);

    // Assistant turn should have cleaned toolUseId: "tooluse_KfDgpsRapEXpRCT6klvI8d"
    const assistantMessage = mappedMessages[1];
    expect(assistantMessage.content?.[0]?.toolUse?.toolUseId).toBe(
      'tooluse_KfDgpsRapEXpRCT6klvI8d',
    );

    // User turn should have cleaned toolUseId: "tooluse_KfDgpsRapEXpRCT6klvI8d"
    const userMessage = mappedMessages[2];
    expect(userMessage.content?.[0]?.toolResult?.toolUseId).toBe(
      'tooluse_KfDgpsRapEXpRCT6klvI8d',
    );
  });
});
