/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ollama } from 'ollama';
import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
} from '@google/genai';
import type { ContentGenerator } from '../contentGenerator.js';
import type { LlmRole } from '../../telemetry/llmRole.js';
import {
  parseOllamaResponse,
  handleOllamaError,
  validateOllamaModel,
  convertToOllamaMessages,
  convertToolsToOllamaFormat,
} from './ollamaUtils.js';
import { ProviderLogger } from './providerLogger.js';
import {
  type OllamaConfig,
  DEFAULT_OLLAMA_CONFIG,
} from './ollamaConfigSchema.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { estimateTokenCountSync } from '../../utils/tokenCalculation.js';

export class OllamaContentGenerator implements ContentGenerator {
  private client: Ollama;
  private config: OllamaConfig;

  constructor(config?: Partial<OllamaConfig>) {
    this.config = {
      ...DEFAULT_OLLAMA_CONFIG,
      ...(config || {}),
    };

    this.client = new Ollama({
      host: this.config.baseUrl,
      timeout: this.config.timeout,
    } as any);
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const modelName = request.model.startsWith('ollama/')
      ? request.model.slice(7)
      : request.model;

    // Validate the model exists outside try block to avoid double-wrapping user-friendly errors
    await validateOllamaModel(modelName, this.config.baseUrl);

    try {
      const messages = convertToOllamaMessages(
        request.contents as Content[],
        request.config?.systemInstruction as any,
      );
      const tools = convertToolsToOllamaFormat(request.config?.tools);

      const requestPayload = {
        messages,
        tools,
        options: {
          temperature: request.config?.temperature ?? this.config.temperature,
          num_predict: request.config?.maxOutputTokens ?? this.config.maxTokens,
          top_p: request.config?.topP ?? this.config.topP,
          stop: request.config?.stopSequences ?? this.config.stopSequences,
          ...(request.config as any)?.options,
        },
      };

      ProviderLogger.logRequest('ollama-debug.log', modelName, requestPayload);

      console.log(
        `[Ollama DEBUG] Sending request to Ollama: messages=${messages.length}, tools=${tools ? tools.length : 0}`,
      );
      const start = Date.now();
      const response = await this.client.chat({
        model: modelName,
        messages,
        tools,
        options: requestPayload.options,
        stream: false,
      });
      console.log(
        `[Ollama DEBUG] Response received in ${Date.now() - start}ms: message=${JSON.stringify(response.message)}`,
      );

      ProviderLogger.logResponse('ollama-debug.log', modelName, response);

      return parseOllamaResponse(response);
    } catch (error) {
      ProviderLogger.logError('ollama-debug.log', modelName, error);
      throw new Error(handleOllamaError(error, modelName));
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
    _requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    // Intercept and delegate 'web-search' model calls to Gemini if a real API Key is present
    if (request.model === 'web-search') {
      const apiKey = process.env['GEMINI_API_KEY'];
      if (apiKey && apiKey !== 'test-api-key') {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: request.contents as any,
          config: {
            tools: [{ googleSearch: {} }],
          },
        });
        const generator = async function* () {
          yield response as any as GenerateContentResponse;
        };
        return generator();
      } else {
        throw new Error(
          'Web search is not supported by Ollama. A valid GEMINI_API_KEY is required to fall back to Gemini search grounding.',
        );
      }
    }

    const modelName = request.model.startsWith('ollama/')
      ? request.model.slice(7)
      : request.model;

    // Validate the model exists outside try block to avoid double-wrapping user-friendly errors
    await validateOllamaModel(modelName, this.config.baseUrl);

    try {
      debugLogger.log(
        `[Ollama] Executing content generation. Forcing non-streaming for absolute reliability, format security, and visual simulator deadlock prevention.`,
      );
      const response = await this.generateContent(
        request,
        _userPromptId,
        _role,
      );
      return (async function* () {
        yield response;
      })();
    } catch (error) {
      throw new Error(handleOllamaError(error, modelName));
    }
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    let modelName = '';
    try {
      // Handle ollama/ prefix if present (similar to bedrock/ handling)
      modelName = request.model.startsWith('ollama/')
        ? request.model.slice(7)
        : request.model;

      // For Ollama, we don't have a direct token counting API.
      // We'll use an estimate based on the text content.
      const parts: any[] = [];

      // Extract all text content from the request contents
      if (Array.isArray(request.contents)) {
        // Handle array of Content items
        for (const content of request.contents) {
          // If it's a string, push as text part
          if (typeof content === 'string') {
            parts.push({ text: content });
          } else if (
            content &&
            typeof content === 'object' &&
            'text' in content
          ) {
            // Single Content with text property
            parts.push({ text: content.text });
          } else if (
            content &&
            typeof content === 'object' &&
            'parts' in content
          ) {
            // Handle Content with parts
            const contentParts = content.parts as any[];
            if (Array.isArray(contentParts)) {
              for (const part of contentParts) {
                if (
                  typeof part === 'object' &&
                  part !== null &&
                  'text' in part
                ) {
                  parts.push({ text: part.text });
                }
              }
            }
          }
        }
      } else {
        // Handle single Content item or direct string
        if (typeof request.contents === 'string') {
          parts.push({ text: request.contents });
        } else if (
          request.contents &&
          typeof request.contents === 'object' &&
          'text' in request.contents
        ) {
          parts.push({ text: request.contents.text });
        } else if (
          request.contents &&
          typeof request.contents === 'object' &&
          'parts' in request.contents
        ) {
          // Handle Content with parts
          const contentParts = request.contents.parts as any[];
          if (Array.isArray(contentParts)) {
            for (const part of contentParts) {
              if (typeof part === 'object' && part !== null && 'text' in part) {
                parts.push({ text: part.text });
              }
            }
          }
        }
      }

      return { totalTokens: estimateTokenCountSync(parts) };
    } catch (error) {
      throw new Error(handleOllamaError(error, modelName || 'unknown'));
    }
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const modelName = request.model.startsWith('ollama/')
      ? request.model.slice(7)
      : request.model;

    // Validate the model exists outside try block to avoid double-wrapping user-friendly errors
    await validateOllamaModel(modelName, this.config.baseUrl);

    try {
      const response = await this.client.embeddings({
        model: modelName,
        prompt: (request.contents as any).parts?.[0]?.text || '',
      });

      return {
        embeddings: [
          {
            values: response.embedding,
          },
        ],
      } as EmbedContentResponse;
    } catch (error) {
      throw new Error(handleOllamaError(error, modelName));
    }
  }
}
