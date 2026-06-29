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
import type { ModelConfigServiceConfig } from '../services/modelConfigService.js';

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
export const AMAZON_NOVA_PRO = 'eu.amazon.nova-2-pro-v1:0';
export const AMAZON_NOVA_LITE = 'eu.amazon.nova-2-lite-v1:0';
export const AMAZON_NOVA_MICRO = 'eu.amazon.nova-2-micro-v1:0';

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
export const DEFAULT_MODEL_CONFIGS: ModelConfigServiceConfig = {
  aliases: {
    // Google Gemini
    'gemini-1.5-pro': { modelConfig: { model: 'google/gemini-1.5-pro' } },
    'gemini-1.5-flash': { modelConfig: { model: 'google/gemini-1.5-flash' } },
    'gemini-2.0-flash-exp': { modelConfig: { model: 'google/gemini-2.0-flash-exp' } },

    // OpenAI
    'gpt-4o': { modelConfig: { model: 'openai/gpt-4o' } },
    'gpt-4o-mini': { modelConfig: { model: 'openai/gpt-4o-mini' } },
    'o1-preview': { modelConfig: { model: 'openai/o1-preview' } },
    'o1-mini': { modelConfig: { model: 'openai/o1-mini' } },

    // Amazon Bedrock
    'nova-pro': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_PRO } },
    'nova-lite': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_LITE } },
    'nova-micro': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_MICRO } },
    'bedrock/nova-pro': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_PRO } },
    'bedrock/nova-lite': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_LITE } },
    'bedrock/nova-micro': { modelConfig: { model: 'bedrock/' + AMAZON_NOVA_MICRO } },

    // Ollama
    'llama3': { modelConfig: { model: 'ollama/' + OLLAMA_LLAMA3 } },
    'mistral': { modelConfig: { model: 'ollama/' + OLLAMA_MISTRAL } },
    'phi3': { modelConfig: { model: 'ollama/' + OLLAMA_PHI3 } },
    'llama3.1': { modelConfig: { model: 'ollama/' + OLLAMA_LLAMA3_1 } },
  },
  modelDefinitions: {
    'gemini-1.5-pro': { tier: 'pro', family: 'gemini-1.5' },
    'gemini-1.5-flash': { tier: 'flash', family: 'gemini-1.5' },
    'nova-pro': { tier: 'pro', family: 'nova', displayName: 'Nova 2 Pro', isVisible: true },
    'nova-lite': { tier: 'flash', family: 'nova', displayName: 'Nova 2 Lite', isVisible: true },
    'nova-micro': { tier: 'flash', family: 'nova', displayName: 'Nova 2 Micro', isVisible: true },
    'bedrock/nova-pro': { tier: 'pro', family: 'nova', isVisible: false },
    'bedrock/nova-lite': { tier: 'flash', family: 'nova', isVisible: false },
    'bedrock/nova-micro': { tier: 'flash', family: 'nova', isVisible: false },
  },
  modelIdResolutions: {},
  classifierIdResolutions: {},
  modelChains: {},
  overrides: [],
};
