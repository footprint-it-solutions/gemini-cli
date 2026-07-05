/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import {
  type GenerateContentParameters,
  GenerateContentResponse,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
  type Part,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import type { LlmRole } from '../../telemetry/llmRole.js';

export class OpenAIContentGenerator implements ContentGenerator {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
    });
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const messages = this.mapContentsToMessages(
      this.ensureContentArray(request.contents),
      request.config?.systemInstruction as any,
    );
    const tools = this.mapTools(request.config?.tools);

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
      tools,
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens,
      top_p: request.config?.topP,
      stop: request.config?.stopSequences,
      response_format:
        request.config?.responseMimeType === 'application/json'
          ? { type: 'json_object' }
          : undefined,
    });

    return this.ensureGenerateContentResponse(this.mapResponse(response));
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
    _requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const messages = this.mapContentsToMessages(
      this.ensureContentArray(request.contents),
      request.config?.systemInstruction as any,
    );
    const tools = this.mapTools(request.config?.tools);

    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages,
      tools,
      temperature: request.config?.temperature,
      max_tokens: request.config?.maxOutputTokens,
      top_p: request.config?.topP,
      stop: request.config?.stopSequences,
      stream: true,
    });

    return this.mapStreamResponse(stream);
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // OpenAI doesn't have a direct token counting API like Gemini.
    // For now, return a placeholder or estimate.
    return { totalTokens: 0 };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Embeddings not yet implemented for OpenAI provider.');
  }

  private ensureContentArray(contents: any): Content[] {
    if (!contents) return [];
    if (Array.isArray(contents)) {
      return contents.map((c) => {
        if (typeof c === 'string')
          return { role: 'user', parts: [{ text: c }] };
        if (c.text) return { role: 'user', parts: [c] };
        return c;
      });
    }
    if (typeof contents === 'string')
      return [{ role: 'user', parts: [{ text: contents }] }];
    if (contents.text) return [{ role: 'user', parts: [contents] }];
    return [contents];
  }

  private ensureGenerateContentResponse(obj: any): GenerateContentResponse {
    Object.setPrototypeOf(obj, GenerateContentResponse.prototype);
    return obj as GenerateContentResponse;
  }

  private mapContentsToMessages(
    contents: Content[],
    systemInstruction?: string | Part | Part[] | Content,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (systemInstruction) {
      let systemText = '';
      if (typeof systemInstruction === 'string') {
        systemText = systemInstruction;
      } else if (Array.isArray(systemInstruction)) {
        systemText = systemInstruction
          .map((p) => (p as any).text || '')
          .join('\n');
      } else if ('parts' in systemInstruction) {
        systemText = (systemInstruction.parts as any[])
          .map((p) => p.text || '')
          .join('\n');
      } else {
        systemText = (systemInstruction as Part).text || '';
      }

      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const parts = content.parts || [];

      // Handle tool calls/responses
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      let textContent = '';

      for (const part of parts) {
        if (part.text) {
          textContent += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).substring(7)}`, // OpenAI needs an ID
            type: 'function',
            function: {
              name: part.functionCall.name || '',
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
        if (part.functionResponse) {
          // functionResponse is handled by a separate message in OpenAI
          messages.push({
            role: 'tool',
            tool_call_id: 'unknown', // This is a limitation: Gemini doesn't track tool call IDs in history the same way
            content: JSON.stringify(part.functionResponse.response),
          });
        }
      }

      if (textContent || toolCalls.length > 0) {
        if (role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          } as any);
        } else {
          messages.push({
            role: 'user',
            content: textContent,
          } as any);
        }
      }
    }

    return messages;
  }

  private mapTools(
    tools?: any[],
  ): OpenAI.Chat.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const openAiTools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const tool of tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          openAiTools.push({
            type: 'function',
            function: {
              name: fd.name,
              description: fd.description,
              parameters: fd.parameters as any,
            },
          });
        }
      }
    }
    return openAiTools.length > 0 ? openAiTools : undefined;
  }

  private mapResponse(response: OpenAI.Chat.ChatCompletion): any {
    const choice = response.choices[0];
    const parts: Part[] = [];

    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const toolCall = tc as any;
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments),
          },
        });
      }
    }

    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts,
          },
          finishReason: this.mapFinishReason(choice.finish_reason),
        },
      ],
      usageMetadata: {
        promptTokenCount: response.usage?.prompt_tokens,
        candidatesTokenCount: response.usage?.completion_tokens,
        totalTokenCount: response.usage?.total_tokens,
      },
      responseId: response.id,
    };
  }

  private async *mapStreamResponse(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  ): AsyncGenerator<GenerateContentResponse> {
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const parts: Part[] = [];
      if (choice.delta.content) {
        parts.push({ text: choice.delta.content });
      }

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.function) {
            // Note: In streaming, tool calls come in chunks.
            // This simple mapping might need refinement for full tool support in streams.
            parts.push({
              functionCall: {
                name: tc.function.name || '',
                args: tc.function.arguments
                  ? JSON.parse(tc.function.arguments)
                  : {},
              },
            });
          }
        }
      }

      yield this.ensureGenerateContentResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts,
            },
            finishReason: this.mapFinishReason(choice.finish_reason),
          },
        ],
        responseId: chunk.id,
      });
    }
  }

  private mapFinishReason(reason: string | null): any {
    switch (reason) {
      case 'stop':
        return 'STOP';
      case 'length':
        return 'MAX_TOKENS';
      case 'tool_calls':
        return 'STOP'; // Or maybe FUNCTION_CALL if it existed in the target enum
      case 'content_filter':
        return 'SAFETY';
      default:
        return 'OTHER';
    }
  }
}
