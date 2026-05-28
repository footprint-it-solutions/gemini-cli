/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type GenerationConfig,
  type SafetySetting,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/genai';

/**
 * Common safety settings for models.
 */
export const DEFAULT_SAFETY_SETTINGS: SafetySetting[] = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

/**
 * Default generation config for general purpose models.
 */
export const DEFAULT_GENERATION_CONFIG: GenerationConfig = {
  temperature: 1.0,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: 'text/plain',
};

/**
 * Model aliases for Amazon Bedrock Nova models.
 */
export const AMAZON_NOVA_PRO = 'us.amazon.nova-pro-v1:0';
export const AMAZON_NOVA_LITE = 'us.amazon.nova-lite-v1:0';
export const AMAZON_NOVA_MICRO = 'us.amazon.nova-micro-v1:0';

/**
 * Model aliases for Ollama models.
 */
export const OLLAMA_LLAMA3 = 'llama3';
export const OLLAMA_MISTRAL = 'mistral';
export const OLLAMA_PHI3 = 'phi3';
export const OLLAMA_LLAMA3_1 = 'llama3.1';

/**
 * Model configuration registry.
 */
export const MODEL_CONFIGS: Record<string, { modelId: string; provider: string }> = {
  // Google Gemini
  'gemini-1.5-pro': { modelId: 'gemini-1.5-pro', provider: 'google' },
  'gemini-1.5-flash': { modelId: 'gemini-1.5-flash', provider: 'google' },
  'gemini-2.0-flash-exp': { modelId: 'gemini-2.0-flash-exp', provider: 'google' },

  // OpenAI
  'gpt-4o': { modelId: 'gpt-4o', provider: 'openai' },
  'gpt-4o-mini': { modelId: 'gpt-4o-mini', provider: 'openai' },
  'o1-preview': { modelId: 'o1-preview', provider: 'openai' },
  'o1-mini': { modelId: 'o1-mini', provider: 'openai' },

  // Amazon Bedrock
  'nova-pro': { modelId: AMAZON_NOVA_PRO, provider: 'bedrock' },
  'nova-lite': { modelId: AMAZON_NOVA_LITE, provider: 'bedrock' },
  'nova-micro': { modelId: AMAZON_NOVA_MICRO, provider: 'bedrock' },

  // Ollama
  'llama3': { modelId: OLLAMA_LLAMA3, provider: 'ollama' },
  'mistral': { modelId: OLLAMA_MISTRAL, provider: 'ollama' },
  'phi3': { modelId: OLLAMA_PHI3, provider: 'ollama' },
  'llama3.1': { modelId: OLLAMA_LLAMA3_1, provider: 'ollama' },
};
