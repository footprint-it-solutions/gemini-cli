/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ollama, type Message } from 'ollama';
import {
  type GenerateContentParameters,
  type GenerateContentResponse,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
  type Part,
  FinishReason,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import type { LlmRole } from '../../telemetry/llmRole.js';

export class OllamaContentGenerator implements ContentGenerator {
  private client: Ollama;

  constructor(host?: string) {
    this.client = new Ollama({
      host: host || process.env['OLLAMA_HOST'] || 'http://localhost:11434',
    });
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const messages = this.mapContentsToMessages(
      request.contents as Content[],
      request.config?.systemInstruction as any,
    );
    const tools = this.mapTools(request.config?.tools);

    const response = await this.client.chat({
      model: request.model,
      messages,
      tools: tools as any,
      options: {
        temperature: request.config?.temperature,
        num_predict: request.config?.maxOutputTokens,
        top_p: request.config?.topP,
        stop: request.config?.stopSequences,
      },
      stream: false,
    });

    return this.mapResponse(response);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
    _requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const messages = this.mapContentsToMessages(
      request.contents as Content[],
      request.config?.systemInstruction as any,
    );
    const tools = this.mapTools(request.config?.tools);

    const stream = await this.client.chat({
      model: request.model,
      messages,
      tools: tools as any,
      options: {
        temperature: request.config?.temperature,
        num_predict: request.config?.maxOutputTokens,
        top_p: request.config?.topP,
        stop: request.config?.stopSequences,
      },
      stream: true,
    });

    return this.mapStreamResponse(stream);
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return { totalTokens: 0 };
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const response = await this.client.embeddings({
      model: request.model,
      prompt: (request.contents as any).parts?.[0]?.text || '',
    });
    return {
      embeddings: [
        {
          values: response.embedding,
        },
      ],
    } as EmbedContentResponse;
  }

  private mapContentsToMessages(
    contents: Content[],
    systemInstruction?: string | Part | Part[] | Content,
  ): Message[] {
    const messages: Message[] = [];

    if (systemInstruction) {
      let systemText = '';
      if (typeof systemInstruction === 'string') {
        systemText = systemInstruction;
      } else if (Array.isArray(systemInstruction)) {
        systemText = systemInstruction
          .map((p) => (p as any).text || '')
          .join('\n');
      } else if (
        systemInstruction &&
        'parts' in systemInstruction &&
        systemInstruction.parts
      ) {
        systemText = systemInstruction.parts
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

      let textContent = '';
      const toolCalls: any[] = [];

      for (const part of parts) {
        if (part.text) {
          textContent += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            function: {
              name: part.functionCall.name,
              arguments: part.functionCall.args,
            },
          });
        }
        if (part.functionResponse) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(part.functionResponse.response),
          });
        }
      }

      if (textContent || toolCalls.length > 0) {
        messages.push({
          role,
          content: textContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    }

    return messages;
  }

  private mapTools(tools?: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const ollamaTools: any[] = [];
    for (const tool of tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          ollamaTools.push({
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
    return ollamaTools.length > 0 ? ollamaTools : undefined;
  }

  private mapResponse(response: any): GenerateContentResponse {
    const parts: Part[] = [];

    if (response.message?.content) {
      parts.push({ text: response.message.content });
    }

    if (response.message?.tool_calls) {
      for (const tc of response.message.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: tc.function.arguments,
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
          finishReason: FinishReason.STOP,
        },
      ],
      usageMetadata: {
        promptTokenCount: response.prompt_eval_count,
        candidatesTokenCount: response.eval_count,
        totalTokenCount:
          (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
    } as GenerateContentResponse;
  }

  private async *mapStreamResponse(
    stream: AsyncIterable<any>,
  ): AsyncGenerator<GenerateContentResponse> {
    for await (const chunk of stream) {
      const parts: Part[] = [];
      if (chunk.message?.content) {
        parts.push({ text: chunk.message.content });
      }

      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: tc.function.arguments,
            },
          });
        }
      }

      yield {
        candidates: [
          {
            content: {
              role: 'model',
              parts,
            },
            finishReason: chunk.done ? FinishReason.STOP : undefined,
          },
        ],
        usageMetadata: chunk.done
          ? {
              promptTokenCount: chunk.prompt_eval_count,
              candidatesTokenCount: chunk.eval_count,
              totalTokenCount:
                (chunk.prompt_eval_count || 0) + (chunk.eval_count || 0),
            }
          : undefined,
      } as GenerateContentResponse;
    }
  }
}
