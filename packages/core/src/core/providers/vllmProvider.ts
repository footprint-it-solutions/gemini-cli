/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import {
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { type LlmRole } from '../../telemetry/llmRole.js';
import { OpenAIContentGenerator } from './openAiProvider.js';
import { ProviderLogger } from './providerLogger.js';

export class VllmContentGenerator extends OpenAIContentGenerator {
  private localClient: OpenAI;
  private remoteClient: OpenAI;
  private readonly logFilename: string;

  constructor(
    apiKey: string,
    baseURL?: string,
    logFilename: string = 'vllm-debug.log',
  ) {
    // Pass to base constructor to satisfy TypeScript
    super(apiKey || 'vllm-dummy-key', baseURL);
    this.logFilename = logFilename;

    const localBaseUrl =
      process.env['VLLM_LOCAL_BASE_URL'] ||
      process.env['VLLM_BASE_URL'] ||
      baseURL ||
      'http://localhost:8000/v1';

    const remoteBaseUrl =
      process.env['VLLM_REMOTE_BASE_URL'] || 'http://x10srh-1-bm:8000/v1';

    const actualApiKey =
      process.env['VLLM_API_KEY'] || apiKey || 'vllm-dummy-key';

    this.localClient = new OpenAI({
      apiKey: actualApiKey,
      baseURL: localBaseUrl,
    });

    this.remoteClient = new OpenAI({
      apiKey: actualApiKey,
      baseURL: remoteBaseUrl,
    });
  }

  private isRemoteModel(model: string): boolean {
    const cleaned = model.toLowerCase();
    return (
      cleaned.includes('26b') ||
      cleaned.includes('gemma4-26b') ||
      cleaned.includes('x10') ||
      cleaned.includes('remote')
    );
  }

  private cleanModelName(model: string): string {
    const cleaned = model.toLowerCase();

    if (cleaned.includes('12b') || cleaned.includes('gemma4-12b')) {
      return 'google/gemma-4-12B-it-qat-q4_0-unquantized';
    }
    if (cleaned.includes('26b') || cleaned.includes('gemma4-26b')) {
      return 'google/gemma-4-12B-it-qat-q4_0-unquantized';
    }

    if (model.startsWith('vllm/')) {
      return model.slice(5);
    }
    return model;
  }

  private getClientForModel(model: string): OpenAI {
    return this.isRemoteModel(model) ? this.remoteClient : this.localClient;
  }

  /**
   * Maps openAI finish reason safely, ignoring null/undefined and None values
   * to prevent useGeminiStream in the CLI from printing spam warnings.
   */
  private vllmMapFinishReason(reason: string | null): any {
    if (!reason || reason === 'None' || reason === 'none') {
      return undefined;
    }
    switch (reason) {
      case 'stop':
        return 'STOP';
      case 'length':
        return 'MAX_TOKENS';
      case 'tool_calls':
        return 'STOP';
      case 'content_filter':
        return 'SAFETY';
      default:
        return 'OTHER';
    }
  }

  /**
   * Translates conversational history into correctly ordered and aligned
   * OpenAI message parameters, pairing tool responses with preceding tool-calls using matching IDs
   * to satisfy vLLM's strict server-side template validator.
   */
  private vllmMapContentsToMessages(
    contents: any[],
    systemInstruction?: any,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // Map system instruction
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
        systemText = (systemInstruction as any).text || '';
      }

      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }

    // Keep track of tool call IDs by name to match responses
    const toolCallIdMap = new Map<string, string>();

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const parts = content.parts || [];

      const toolCalls: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      const toolResponses: any[] = [];
      let textContent = '';

      for (const part of parts) {
        if (part.text) {
          // Clean standard text of any raw control/template tokens before saving to history
          // to prevent models from entering infinite self-reinforcement loops.
          textContent += this.stripControlTokens(part.text);
        }
        if (part.functionCall) {
          const callId = `call_${part.functionCall.name}_${Math.random().toString(36).substring(5)}`;
          // Store the generated stable ID for matching later
          toolCallIdMap.set(part.functionCall.name, callId);

          toolCalls.push({
            id: callId,
            type: 'function',
            function: {
              name: part.functionCall.name || '',
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          } as any);
        }
        if (part.functionResponse) {
          const callId =
            toolCallIdMap.get(part.functionResponse.name) ||
            `call_unknown_${Math.random().toString(36).substring(5)}`;
          toolResponses.push({
            role: 'tool',
            tool_call_id: callId,
            content:
              typeof part.functionResponse.response === 'string'
                ? part.functionResponse.response
                : JSON.stringify(part.functionResponse.response || {}),
          });
        }
      }

      // If we have tool responses in this turn, push them to the messages array immediately
      if (toolResponses.length > 0) {
        for (const resp of toolResponses) {
          messages.push(resp);
        }
        continue;
      }

      // If we have assistant or user text/tool-calls, push them in the correct sequence
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

  /**
   * Cleans Gemma 4 template control tokens from stream text outputs to guarantee a clean TUI
   * and completely immune chat histories.
   */
  private stripControlTokens(text: string): string {
    return text
      .replace(/✦/g, '')
      .replace(/<\|[\s\S]*?\|>/g, '') // Purges <|channel|>, <|thought|>, <|tool_call|>, <|...|>
      .replace(/<channel\|>/g, '')
      .replace(/<\|channel>/g, '')
      .replace(/<tool_call\|>/g, '')
      .replace(/<\/tool_call>/g, '')
      .replace(/<thought\|>/g, '')
      .replace(/<\/thought>/g, '');
  }

  /**
   * Injects prompt instructions to compel non-native reasoning models (like Gemma 4)
   * to separate reasoning inside standard XML `<thought>` and `</thought>` tags.
   */
  private injectThinkingInstruction(systemInstruction: any): any {
    const thinkingPrompt =
      'CRITICAL INSTRUCTION: You must separate your reasoning from your final response. ' +
      'Before answering, write your step-by-step thinking process, chain-of-thought, and self-corrections ' +
      'wrapped inside <thought> and </thought> XML tags. Do not skip these tags. ' +
      'Example format:\n' +
      '<thought>\nThinking steps here...\n</thought>\nFinal response here...';

    if (!systemInstruction) {
      return {
        parts: [{ text: thinkingPrompt }],
      };
    }

    if (typeof systemInstruction === 'string') {
      return systemInstruction + '\n\n' + thinkingPrompt;
    }

    if (systemInstruction.parts) {
      return {
        ...systemInstruction,
        parts: [...systemInstruction.parts, { text: '\n\n' + thinkingPrompt }],
      };
    }

    return systemInstruction;
  }

  /**
   * Parses Gemma 4 native inline tool calling token blocks on-the-fly.
   * Example: <|tool_call>call:tool_name{args}<tool_call|>
   */
  private parseInlineToolCall(
    text: string,
  ): { name: string; args: any } | null {
    // 1. Standardize quotes and escaping tokens: <|" -> " and |> -> "
    let cleaned = text
      .replace(/<\|"/g, '"')
      .replace(/"\|>/g, '"')
      .replace(/<\|/g, '')
      .replace(/\|>/g, '');

    // Matches tool_call>call:tool_name{JSON}
    const match = cleaned.match(
      /tool_call>?\s*call:([a-zA-Z0-9_\-]+)\s*(\{[\s\S]*?\})/,
    );
    if (match) {
      const name = match[1];
      let argsStr = match[2];

      // 2. Quotes unquoted JSON keys on the fly (e.g. {path: "..."} -> {"path": "..."})
      argsStr = argsStr.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

      try {
        const args = JSON.parse(argsStr);

        // 3. Fallback parameter alignment for Gemini CLI standard tool schemas
        if (args.path && !args.file_path) {
          args.file_path = args.path;
        }

        return { name, args };
      } catch {
        return { name, args: {} };
      }
    }
    return null;
  }

  override async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const hasTools = !!request.config?.tools?.length;
    // Disable visual thinking prompt instructions when tools are present to prevent
    // conflicting system instructions from confusing the model into loop generations.
    const isThinkingEnabled = !!request.config?.thinkingConfig && !hasTools;

    // Inject a default system prompt when tools are present to satisfy vLLM's
    // internal Python string-concatenation engine and prevent the 400 NoneType error.
    let systemInstruction = request.config?.systemInstruction;
    if (hasTools && !systemInstruction) {
      systemInstruction =
        'You are Gemini CLI, a helpful AI assistant with terminal capabilities.';
    }

    const updatedRequest = {
      ...request,
      config: {
        ...request.config,
        systemInstruction: isThinkingEnabled
          ? this.injectThinkingInstruction(systemInstruction)
          : systemInstruction,
      },
    };

    const client = this.getClientForModel(updatedRequest.model);
    const model = this.cleanModelName(updatedRequest.model);

    const messages = this.vllmMapContentsToMessages(
      (this as any).ensureContentArray(updatedRequest.contents),
      updatedRequest.config?.systemInstruction as any,
    );
    const tools = (this as any).mapTools(updatedRequest.config?.tools);

    const requestPayload = {
      model,
      messages,
      tools,
      temperature: updatedRequest.config?.temperature,
      max_tokens: updatedRequest.config?.maxOutputTokens,
      top_p: updatedRequest.config?.topP,
      stop: updatedRequest.config?.stopSequences,
      response_format:
        updatedRequest.config?.responseMimeType === 'application/json'
          ? ({ type: 'json_object' } as any)
          : undefined,
    };

    ProviderLogger.logRequest(this.logFilename, model, requestPayload);

    let response;
    try {
      response = await client.chat.completions.create(requestPayload as any);
    } catch (error: any) {
      // Gracefully handle servers that do not have auto-tool-choice enabled on their engines
      if (
        error.status === 400 &&
        String(error.message || '').includes('tool choice')
      ) {
        console.warn(
          '[vLLM] Native auto-tool-choice is not configured on the server. Falling back to text-only mode.',
        );
        const fallbackPayload = {
          model,
          messages,
          temperature: updatedRequest.config?.temperature,
          max_tokens: updatedRequest.config?.maxOutputTokens,
          top_p: updatedRequest.config?.topP,
          stop: updatedRequest.config?.stopSequences,
          response_format:
            updatedRequest.config?.responseMimeType === 'application/json'
              ? ({ type: 'json_object' } as any)
              : undefined,
        };
        ProviderLogger.log(
          this.logFilename,
          'INFO',
          'Falling back to text-only mode due to tool choice 400 error.',
          fallbackPayload,
        );
        response = await client.chat.completions.create(fallbackPayload as any);
      } else {
        ProviderLogger.logError(this.logFilename, model, error);
        throw error;
      }
    }

    const baseResponse = (this as any).ensureGenerateContentResponse(
      (this as any).mapResponse(response),
    );
    ProviderLogger.logResponse(this.logFilename, model, baseResponse);

    // Parse non-streaming inline tool-calls to prevent tag leakage
    const choice = baseResponse.candidates?.[0];
    const textPart = choice?.content?.parts?.[0];
    if (textPart && textPart.text && textPart.text.includes('tool_call')) {
      const parsed = this.parseInlineToolCall(textPart.text);
      if (parsed) {
        choice.content.parts = [
          {
            functionCall: {
              name: parsed.name,
              args: parsed.args,
            },
          },
        ];
        return baseResponse;
      }
    }

    if (!isThinkingEnabled) {
      // Sanitize standard text from raw template control tokens
      if (textPart && textPart.text) {
        textPart.text = this.stripControlTokens(textPart.text);
      }
      return baseResponse;
    }

    // Translate non-streaming XML tags to Gemini JSON parts
    if (textPart && textPart.text) {
      const rawText = textPart.text;
      const parts: any[] = [];

      let lastIndex = 0;
      while (true) {
        const startIndex = rawText.indexOf('<thought>', lastIndex);
        if (startIndex === -1) {
          const remainder = rawText.slice(lastIndex);
          if (remainder) {
            parts.push({ text: this.stripControlTokens(remainder) });
          }
          break;
        }

        const before = rawText.slice(lastIndex, startIndex);
        if (before) {
          parts.push({ text: this.stripControlTokens(before) });
        }

        const endIndex = rawText.indexOf('</thought>', startIndex);
        if (endIndex === -1) {
          const inside = rawText.slice(startIndex + 9);
          if (inside) {
            parts.push({
              text: this.stripControlTokens(inside),
              thought: true,
            });
          }
          break;
        }

        const inside = rawText.slice(startIndex + 9, endIndex);
        if (inside) {
          parts.push({ text: this.stripControlTokens(inside), thought: true });
        }

        lastIndex = endIndex + 10;
      }

      // Preserve other parts (like functionCalls) if present
      const otherParts = choice.content.parts.slice(1);
      choice.content.parts = [...parts, ...otherParts];
    }

    return baseResponse;
  }

  override async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
    requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const hasTools = !!request.config?.tools?.length;
    // Disable visual thinking prompt instructions when tools are present to prevent
    // conflicting system instructions from confusing the model into loop generations.
    const isThinkingEnabled = !!request.config?.thinkingConfig && !hasTools;

    // Inject a default system prompt when tools are present to satisfy vLLM's
    // internal Python string-concatenation engine and prevent the 400 NoneType error.
    let systemInstruction = request.config?.systemInstruction;
    if (hasTools && !systemInstruction) {
      systemInstruction =
        'You are Gemini CLI, a helpful AI assistant with terminal capabilities.';
    }

    const updatedRequest = {
      ...request,
      config: {
        ...request.config,
        systemInstruction: isThinkingEnabled
          ? this.injectThinkingInstruction(systemInstruction)
          : systemInstruction,
      },
    };

    const client = this.getClientForModel(updatedRequest.model);
    const model = this.cleanModelName(updatedRequest.model);

    const messages = this.vllmMapContentsToMessages(
      (this as any).ensureContentArray(updatedRequest.contents),
      updatedRequest.config?.systemInstruction as any,
    );
    const tools = (this as any).mapTools(updatedRequest.config?.tools);

    const requestPayload = {
      model,
      messages,
      tools,
      temperature: updatedRequest.config?.temperature,
      max_tokens: updatedRequest.config?.maxOutputTokens,
      top_p: updatedRequest.config?.topP,
      stop: updatedRequest.config?.stopSequences,
      stream: true,
    };

    ProviderLogger.logRequest(this.logFilename, model, requestPayload);

    let stream;
    try {
      stream = (await client.chat.completions.create(
        requestPayload as any,
      )) as any;
    } catch (error: any) {
      // Gracefully handle servers that do not have auto-tool-choice enabled on their engines
      if (
        error.status === 400 &&
        String(error.message || '').includes('tool choice')
      ) {
        console.warn(
          '[vLLM] Native auto-tool-choice is not configured on the server. Falling back to text-only mode.',
        );
        const fallbackPayload = {
          model,
          messages,
          temperature: updatedRequest.config?.temperature,
          max_tokens: updatedRequest.config?.maxOutputTokens,
          top_p: updatedRequest.config?.topP,
          stop: updatedRequest.config?.stopSequences,
          stream: true,
        };
        ProviderLogger.log(
          this.logFilename,
          'INFO',
          'Falling back stream to text-only mode due to tool choice 400 error.',
          fallbackPayload,
        );
        stream = (await client.chat.completions.create(
          fallbackPayload as any,
        )) as any;
      } else {
        ProviderLogger.logError(this.logFilename, model, error);
        throw error;
      }
    }

    // High performance XML/inline-tool to Gemini JSON stream translator state-machine!
    return this.translateXmlStream(stream, isThinkingEnabled, model);
  }

  /**
   * Real-time streaming state-machine parser.
   * Strips `<thought>` and `</thought>` tags on-the-fly and yields them as proper
   * Gemini-compatible text chunks with `thought: true` metadata.
   * Also captures Gemma 4 native inline tool calling tokens and maps them to standard tool callbacks.
   */
  private async *translateXmlStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    isThinkingEnabled: boolean,
    model: string = 'unknown',
  ): AsyncGenerator<GenerateContentResponse> {
    let inThought = false;
    let buffer = '';

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const chunkText = choice?.delta?.content || '';
      const finishReason = choice?.finish_reason;

      if (chunkText) {
        ProviderLogger.logStreamChunk(this.logFilename, model, chunkText);
      }

      // Extract usage if available
      const usage = (chunk as any).usage;

      if (!chunkText) {
        // If there's no text but there is a finish reason or tools call, map them surgically to prevent TypeError
        if (choice?.delta?.tool_calls || finishReason) {
          const parts: any[] = [];
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.function) {
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
          yield (this as any).ensureGenerateContentResponse({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts,
                },
                finishReason: this.vllmMapFinishReason(finishReason),
              },
            ],
            responseId: chunk.id,
          });
        }
        continue;
      }

      buffer += chunkText;

      // Gemma 4 native inline tool call parser
      if (buffer.includes('tool_call')) {
        const closeIndex = buffer.indexOf('tool_call|>');
        const altCloseIndex = buffer.indexOf('/tool_call>');
        const finalCloseIndex =
          closeIndex !== -1
            ? closeIndex + 11
            : altCloseIndex !== -1
              ? altCloseIndex + 11
              : -1;

        if (finalCloseIndex !== -1) {
          const toolCallText = buffer.slice(0, finalCloseIndex);
          buffer = buffer.slice(finalCloseIndex);

          const parsed = this.parseInlineToolCall(toolCallText);
          if (parsed) {
            yield (this as any).ensureGenerateContentResponse({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: parsed.name,
                          args: parsed.args,
                        },
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              responseId: chunk.id,
            });
            continue;
          }
        }

        // Wait to accumulate complete tool call string across stream boundaries
        continue;
      }

      // If thinking is disabled, immediately yield sanitized standard text deltas
      if (!isThinkingEnabled) {
        const cleanText = this.stripControlTokens(buffer);
        if (cleanText) {
          yield (this as any).ensureGenerateContentResponse({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: cleanText }],
                },
                finishReason: this.vllmMapFinishReason(finishReason),
              },
            ],
            responseId: chunk.id,
          });
        }
        buffer = '';
        continue;
      }

      const itemsToYield: Array<{ text: string; thought: boolean }> = [];

      while (buffer.length > 0) {
        if (!inThought) {
          const tagIndex = buffer.indexOf('<thought>');
          if (tagIndex !== -1) {
            const before = buffer.slice(0, tagIndex);
            if (before) {
              itemsToYield.push({
                text: this.stripControlTokens(before),
                thought: false,
              });
            }
            buffer = buffer.slice(tagIndex + 9);
            inThought = true;
          } else {
            // Check for partial tag starting at the end of the buffer (e.g. '<th')
            let partialMatch = false;
            for (let i = 1; i < 9; i++) {
              if (buffer.endsWith('<thought>'.slice(0, i))) {
                partialMatch = true;
                break;
              }
            }
            if (partialMatch) {
              break;
            }
            itemsToYield.push({
              text: this.stripControlTokens(buffer),
              thought: false,
            });
            buffer = '';
          }
        } else {
          const tagIndex = buffer.indexOf('</thought>');
          if (tagIndex !== -1) {
            const before = buffer.slice(0, tagIndex);
            if (before) {
              itemsToYield.push({
                text: this.stripControlTokens(before),
                thought: true,
              });
            }
            buffer = buffer.slice(tagIndex + 10);
            inThought = false;
          } else {
            // Check for partial closing tag starting at the end of buffer
            let partialMatch = false;
            for (let i = 1; i < 10; i++) {
              if (buffer.endsWith('</thought>'.slice(0, i))) {
                partialMatch = true;
                break;
              }
            }
            if (partialMatch) {
              break;
            }
            itemsToYield.push({
              text: this.stripControlTokens(buffer),
              thought: true,
            });
            buffer = '';
          }
        }
      }

      for (const item of itemsToYield) {
        if (item.text) {
          yield (this as any).ensureGenerateContentResponse({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    item.thought
                      ? { text: item.text, thought: true }
                      : { text: item.text },
                  ],
                },
                finishReason: this.vllmMapFinishReason(finishReason),
              },
            ],
            usageMetadata: usage
              ? {
                  promptTokenCount: usage.prompt_tokens,
                  candidatesTokenCount: usage.completion_tokens,
                  totalTokenCount: usage.total_tokens,
                }
              : undefined,
            responseId: chunk.id,
          });
        }
      }
    }

    // Flush any leftover buffer at end of stream
    if (buffer) {
      const isToolCall = buffer.includes('tool_call');
      if (isToolCall) {
        const parsed = this.parseInlineToolCall(buffer);
        if (parsed) {
          yield (this as any).ensureGenerateContentResponse({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: parsed.name,
                        args: parsed.args,
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          });
          return;
        }
      }

      const cleanText = this.stripControlTokens(buffer);
      if (cleanText) {
        yield (this as any).ensureGenerateContentResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  inThought
                    ? { text: cleanText, thought: true }
                    : { text: cleanText },
                ],
              },
            },
          ],
        });
      }
    }
  }
}
