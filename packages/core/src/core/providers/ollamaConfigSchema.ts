/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/**
 * Configuration schema for Ollama provider
 */

// Base configuration for Ollama
export const ollamaConfigSchema = z.object({
  /**
   * Base URL for Ollama API (default: http://localhost:11434)
   */
  baseUrl: z.string().url().optional().default('http://localhost:11434'),

  /**
   * Default timeout for Ollama API requests in milliseconds
   */
  timeout: z.number().positive().optional().default(30000),

  /**
   * Maximum number of tokens to generate in a single call
   */
  maxTokens: z.number().positive().optional(),

  /**
   * Temperature for sampling (0-1, higher = more creative)
   */
  temperature: z.number().min(0).max(2).optional(),

  /**
   * Top-p sampling parameter (nucleus sampling)
   */
  topP: z.number().min(0).max(1).optional(),

  /**
   * Stop sequences to stop generation
   */
  stopSequences: z.array(z.string()).optional(),

  /**
   * Enable or disable streaming responses
   */
  streaming: z.boolean().optional().default(true),

  /**
   * Enable or disable parallel processing of tool calls
   */
  parallelToolCalls: z.boolean().optional().default(true),
});

/**
 * Type for Ollama configuration
 */
export type OllamaConfig = z.infer<typeof ollamaConfigSchema>;

/**
 * Default configuration values
 */
export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: 'http://localhost:11434',
  timeout: 30000,
  streaming: true,
  parallelToolCalls: true,
};
