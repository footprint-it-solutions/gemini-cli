/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ollama } from 'ollama';
import {
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
  handleOllamaError,
  validateOllamaModel,
  convertToOllamaMessages,
  convertToolsToOllamaFormat,
  convertSchemaTypesToLowercase,
} from './ollamaUtils.js';
import { ProviderLogger } from './providerLogger.js';
import {
  type OllamaConfig,
  DEFAULT_OLLAMA_CONFIG,
} from './ollamaConfigSchema.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { estimateTokenCountSync } from '../../utils/tokenCalculation.js';

/**
 * Cleans and sanitizes raw JSON/arguments inside tool call tag streams.
 * Strips XML tags (like <parameters>, <arguments>, <parameter=dir>), markdown,
 * reconstructs missing braces, maps path keys, and injects стратеги_intent fallback.
 */
function cleanAndParseArgs(
  toolName: string,
  rawJson: string,
): Record<string, any> {
  let args: Record<string, any> = {};

  let cleanedJson = rawJson.trim();

  // Strip XML tag blocks globally like <parameters>, <arguments>, <parameter=...>, </parameter>, </function>
  cleanedJson = cleanedJson.replace(/<parameters>/gi, '');
  cleanedJson = cleanedJson.replace(/<\/parameters>/gi, '');
  cleanedJson = cleanedJson.replace(/<arguments>/gi, '');
  cleanedJson = cleanedJson.replace(/<\/arguments>/gi, '');
  cleanedJson = cleanedJson.replace(/<parameter=[^>]+>/gi, '');
  cleanedJson = cleanedJson.replace(/<\/parameter>/gi, '');
  cleanedJson = cleanedJson.replace(/<\/function>/gi, '');
  cleanedJson = cleanedJson.trim();

  // Defeat "Markdown-in-JSON" Trap by stripping markdown code blocks
  cleanedJson = cleanedJson.replace(/^```(?:json)?/i, '');
  cleanedJson = cleanedJson.replace(/```$/, '');
  cleanedJson = cleanedJson.trim();

  // Fallback 1: If the cleaned text is not JSON but is a raw string, wrap it based on the tool
  if (cleanedJson && !cleanedJson.startsWith('{')) {
    if (cleanedJson.includes(':')) {
      // It is JSON fields but missing the enclosing braces (e.g. "title": "Review", "summary": "...")
      cleanedJson = '{' + cleanedJson + '}';
    } else {
      // It is a raw text value (e.g. a raw directory path or file path)
      if (toolName === 'list_directory') {
        args = { dir_path: cleanedJson };
        cleanedJson = ''; // skip standard JSON parsing
      } else if (toolName === 'read_file' || toolName === 'write_file') {
        args = { file_path: cleanedJson };
        cleanedJson = ''; // skip standard JSON parsing
      }
    }
  }

  if (cleanedJson) {
    try {
      args = JSON.parse(cleanedJson);
    } catch (e: any) {
      debugLogger.error(
        `[Ollama Stream Parser] Failed to parse JSON arguments: ${cleanedJson} (${e.message})`,
      );
      args = { __malformed_text: rawJson, __error: e.message };
    }
  }

  // Inject path mapping for compatibility with tools expecting file_path or dir_path
  const pathKeys = ['path', 'file', 'filename'];
  for (const key of pathKeys) {
    if (args[key]) {
      if (
        !args['file_path'] &&
        (toolName === 'read_file' || toolName === 'write_file')
      ) {
        args['file_path'] = args[key];
      }
      if (!args['dir_path'] && toolName === 'list_directory') {
        args['dir_path'] = args[key];
      }
    }
  }

  if (args['dir'] && !args['dir_path'] && toolName === 'list_directory') {
    args['dir_path'] = args['dir'];
  }

  // Inject update_topic strategic_intent fallback if omitted by the model
  if (toolName === 'update_topic' && !args['strategic_intent']) {
    args['strategic_intent'] =
      args['summary'] ||
      args['title'] ||
      'Executing task and orchestrating next steps.';
  }

  return args;
}

export class OllamaStreamingParser {
  private mode: 'TEXT' | 'POTENTIAL_START' | 'TOOL_NAME' | 'TOOL_ARGS' = 'TEXT';
  private buffer = '';
  private toolName = '';
  private toolArgsBuffer = '';

  constructor() {}

  /**
   * Processes a single raw text token from Ollama stream.
   * Yields zero or more GenerateContentResponse objects depending on state transitions.
   */
  *processToken(token: string): Generator<GenerateContentResponse> {
    const TARGET_PREFIX = '<tool_call name="';

    for (let i = 0; i < token.length; i++) {
      const char = token[i];

      if (this.mode === 'TEXT') {
        if (char === '<') {
          this.mode = 'POTENTIAL_START';
          this.buffer = '<';
        } else {
          yield this.createTextResponse(char);
        }
      } else if (this.mode === 'POTENTIAL_START') {
        this.buffer += char;

        if (this.buffer === TARGET_PREFIX) {
          this.mode = 'TOOL_NAME';
          this.toolName = '';
          this.buffer = '';
        } else if (TARGET_PREFIX.startsWith(this.buffer)) {
          // It's still a potential match, keep buffering
          continue;
        } else {
          // Not a match! Flush the buffer as normal text and revert to TEXT mode
          for (const bufferedChar of this.buffer) {
            yield this.createTextResponse(bufferedChar);
          }
          this.buffer = '';
          this.mode = 'TEXT';
        }
      } else if (this.mode === 'TOOL_NAME') {
        this.buffer += char;
        if (this.buffer.endsWith('">')) {
          this.toolName = this.buffer.slice(0, -2);
          this.mode = 'TOOL_ARGS';
          this.toolArgsBuffer = '';
          this.buffer = '';
        }
      } else if (this.mode === 'TOOL_ARGS') {
        this.toolArgsBuffer += char;

        // Resiliency check: If we encounter the start of a new tool call inside TOOL_ARGS,
        // it means the previous tool call was unclosed or called in parallel without a closing tag.
        // We parse the unclosed arguments (if any), yield the previous tool call, and reset parser state
        // to parse the new tool call name.
        if (this.toolArgsBuffer.endsWith(TARGET_PREFIX)) {
          const unclosedArgsRaw = this.toolArgsBuffer
            .slice(0, -TARGET_PREFIX.length)
            .trim();
          const args = cleanAndParseArgs(this.toolName, unclosedArgsRaw);

          ProviderLogger.log(
            'ollama-stream-debug.log',
            'RESPONSE',
            `Parsed unclosed function call from stream: ${this.toolName}`,
            args,
          );
          yield this.createFunctionCallResponse(this.toolName, args);

          // Reset parser state but direct into TOOL_NAME mode to capture the new tool name
          this.mode = 'TOOL_NAME';
          this.toolName = '';
          this.toolArgsBuffer = '';
          this.buffer = '';
          continue;
        }

        if (this.toolArgsBuffer.endsWith('</tool_call>')) {
          const rawJson = this.toolArgsBuffer.slice(0, -12).trim();
          const args = cleanAndParseArgs(this.toolName, rawJson);

          ProviderLogger.log(
            'ollama-stream-debug.log',
            'RESPONSE',
            `Parsed function call from stream: ${this.toolName}`,
            args,
          );

          yield this.createFunctionCallResponse(this.toolName, args);

          // Reset parser state
          this.mode = 'TEXT';
          this.buffer = '';
          this.toolName = '';
          this.toolArgsBuffer = '';
        }
      }
    }
  }

  /**
   * Flushes any remaining characters left in the buffer at the end of the stream.
   */
  *flush(): Generator<GenerateContentResponse> {
    if (this.buffer) {
      for (const char of this.buffer) {
        yield this.createTextResponse(char);
      }
      this.buffer = '';
    }
    if (this.toolArgsBuffer) {
      // If we got cut off mid-JSON, flush it as text
      for (const char of this.toolArgsBuffer) {
        yield this.createTextResponse(char);
      }
      this.toolArgsBuffer = '';
    }
  }

  private createTextResponse(text: string): GenerateContentResponse {
    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text }],
          },
          finishReason: 'STOP',
        },
      ],
    } as any as GenerateContentResponse;
  }

  private createFunctionCallResponse(
    name: string,
    args: Record<string, any>,
  ): GenerateContentResponse {
    const id = `call_${Math.random().toString(36).substring(2, 9)}`;
    const fnCall = { name, args, id };
    return {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: fnCall }],
          },
          finishReason: 'STOP',
        },
      ],
      functionCalls: [fnCall],
    } as any as GenerateContentResponse;
  }
}

export class OllamaStreamingContentGenerator implements ContentGenerator {
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
    const modelName = request.model.startsWith('ollama-stream/')
      ? request.model.slice(14)
      : request.model.startsWith('ollama/')
        ? request.model.slice(7)
        : request.model;

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

      ProviderLogger.logRequest(
        'ollama-stream-debug.log',
        modelName,
        requestPayload,
      );

      const response = await this.client.chat({
        model: modelName,
        messages,
        tools,
        options: requestPayload.options,
        stream: false,
      });

      ProviderLogger.logResponse(
        'ollama-stream-debug.log',
        modelName,
        response,
      );

      // Standardize the response structure
      const parts: any[] = [];
      const content = response.message?.content || '';

      if (
        response.message?.tool_calls &&
        response.message.tool_calls.length > 0
      ) {
        for (const tc of response.message.tool_calls) {
          const tcAny = tc as any;
          const args = tcAny.function.arguments || {};
          if (
            (tcAny.function.name === 'read_file' ||
              tcAny.function.name === 'write_file') &&
            args['path'] &&
            !args['file_path']
          ) {
            args['file_path'] = args['path'];
          }
          parts.push({
            functionCall: {
              id:
                tcAny.id ||
                `call_${Math.random().toString(36).substring(2, 9)}`,
              name: tcAny.function.name,
              args,
            },
          });
        }
      }

      if (parts.length === 0 && content) {
        parts.push({ text: content });
      }

      const functionCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => p.functionCall);

      return {
        candidates: [
          {
            content: {
              role: 'model',
              parts,
            },
            finishReason: 'STOP',
          },
        ],
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        usageMetadata: {
          promptTokenCount: response.prompt_eval_count || 0,
          candidatesTokenCount: response.eval_count || 0,
          totalTokenCount:
            (response.prompt_eval_count || 0) + (response.eval_count || 0),
        },
      } as any as GenerateContentResponse;
    } catch (error) {
      ProviderLogger.logError('ollama-stream-debug.log', modelName, error);
      throw new Error(handleOllamaError(error, modelName));
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
    _requestId?: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const modelName = request.model.startsWith('ollama-stream/')
      ? request.model.slice(14)
      : request.model.startsWith('ollama/')
        ? request.model.slice(7)
        : request.model;

    await validateOllamaModel(modelName, this.config.baseUrl);

    let systemInstruction = request.config?.systemInstruction;
    if (request.config?.tools) {
      let toolsText =
        '\n\n============================================================\n';
      toolsText +=
        'CRITICAL TOOL CALLING INSTRUCTIONS (STRICT FORMAT REQUIRED)\n';
      toolsText +=
        '============================================================\n';
      toolsText += 'You have access to the following tools:\n';
      for (const tool of request.config.tools) {
        const toolAny = tool as any;
        if (toolAny.functionDeclarations) {
          for (const fd of toolAny.functionDeclarations) {
            // Converts uppercase type names recursively in schemas to lowercase for standard Ollama compatibility
            const cleanedParameters = convertSchemaTypesToLowercase(
              fd.parameters || {},
            );
            toolsText += `- Name: ${fd.name}\n  Description: ${fd.description || ''}\n  Parameters: ${JSON.stringify(cleanedParameters)}\n`;
          }
        }
      }
      toolsText += '\nFORMAT RULES FOR CALLING TOOLS:\n';
      toolsText +=
        '1. When you need to call a tool, you MUST use the following exact XML block:\n';
      toolsText +=
        '   <tool_call name="TOOL_NAME">JSON_ARGUMENTS</tool_call>\n';
      toolsText +=
        '2. Do NOT wrap the JSON inside markdown code blocks (no ``` or ```json). Put the raw JSON directly inside the XML tags.\n';
      toolsText +=
        '3. Do NOT announce the tool call or output any explanatory text before or after the XML block. Output the XML block immediately in your stream.\n';
      toolsText +=
        '4. Ensure the JSON arguments are valid and match the parameters of the tool.\n';
      toolsText +=
        '5. Do NOT use Python/JS function call syntax like tool_name(arg=val). Always use the <tool_call> XML format.\n';
      toolsText += '6. If no tool is needed, respond with standard markdown.\n';
      toolsText +=
        '============================================================\n';

      if (systemInstruction) {
        if (typeof systemInstruction === 'string') {
          systemInstruction = systemInstruction + toolsText;
        } else if (Array.isArray(systemInstruction)) {
          systemInstruction.push({ text: toolsText } as any);
        } else if (
          typeof systemInstruction === 'object' &&
          'parts' in systemInstruction
        ) {
          (systemInstruction as any).parts.push({ text: toolsText });
        }
      } else {
        systemInstruction = toolsText;
      }
    }

    const messages = convertToOllamaMessages(
      request.contents as Content[],
      systemInstruction as any,
    );

    const requestPayload = {
      messages,
      options: {
        temperature: request.config?.temperature,
        num_predict: request.config?.maxOutputTokens,
        top_p: request.config?.topP,
        stop: request.config?.stopSequences,
      },
    };

    ProviderLogger.logRequest(
      'ollama-stream-debug.log',
      modelName,
      requestPayload,
    );

    const parser = new OllamaStreamingParser();
    const client = this.client;

    return (async function* () {
      try {
        const stream = await client.chat({
          model: modelName,
          messages,
          options: requestPayload.options,
          stream: true,
        });

        for await (const chunk of stream) {
          const token = chunk.message?.content || '';
          if (token) {
            ProviderLogger.logStreamChunk(
              'ollama-stream-debug.log',
              modelName,
              token,
            );
          }
          for (const response of parser.processToken(token)) {
            yield response;
          }
        }

        for (const response of parser.flush()) {
          yield response;
        }
      } catch (error) {
        ProviderLogger.logError('ollama-stream-debug.log', modelName, error);
        throw new Error(handleOllamaError(error, modelName));
      }
    })();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const parts: any[] = [];
    if (Array.isArray(request.contents)) {
      for (const content of request.contents) {
        if (typeof content === 'string') {
          parts.push({ text: content });
        } else if (
          content &&
          typeof content === 'object' &&
          'text' in content
        ) {
          parts.push({ text: content.text });
        } else if (
          content &&
          typeof content === 'object' &&
          'parts' in content
        ) {
          const contentParts = content.parts as any[];
          if (Array.isArray(contentParts)) {
            for (const part of contentParts) {
              if (typeof part === 'object' && part !== null && 'text' in part) {
                parts.push({ text: part.text });
              }
            }
          }
        }
      }
    } else {
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
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const modelName = request.model.startsWith('ollama-stream/')
      ? request.model.slice(14)
      : request.model.startsWith('ollama/')
        ? request.model.slice(7)
        : request.model;

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
