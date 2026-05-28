/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';

export const GEMINI_1_5_PRO = 'gemini-1.5-pro';
export const GEMINI_1_5_FLASH = 'gemini-1.5-flash';
export const GEMINI_1_5_FLASH_8B = 'gemini-1.5-flash-8b';
export const GEMINI_2_0_FLASH_EXP = 'gemini-2.0-flash-exp';
export const GEMINI_2_0_FLASH_THINKING_EXP = 'gemini-2.0-flash-thinking-exp';
export const GEMINI_2_0_PRO_EXP = 'gemini-2.0-pro-exp-02-05';
export const GEMINI_2_0_FLASH = 'gemini-2.0-flash';
export const GEMINI_2_0_FLASH_LITE = 'gemini-2.0-flash-lite';
export const GEMINI_2_0_FLASH_LITE_PREVIEW = 'gemini-2.0-flash-lite-preview-02-05';

export const OPENAI_GPT_4O = 'gpt-4o';
export const OPENAI_GPT_4O_MINI = 'gpt-4o-mini';

export const BEDROCK_NOVA_PRO = 'nova-pro';
export const BEDROCK_NOVA_LITE = 'nova-lite';
export const BEDROCK_NOVA_MICRO = 'nova-micro';

export const OLLAMA_LLAMA3 = 'llama3';
export const OLLAMA_MISTRAL = 'mistral';

export const ALL_MODELS = [
  GEMINI_2_0_FLASH,
  GEMINI_2_0_FLASH_LITE,
  GEMINI_2_0_PRO_EXP,
  GEMINI_2_0_FLASH_EXP,
  GEMINI_1_5_PRO,
  GEMINI_1_5_FLASH,
  GEMINI_1_5_FLASH_8B,
  OPENAI_GPT_4O,
  OPENAI_GPT_4O_MINI,
  BEDROCK_NOVA_PRO,
  BEDROCK_NOVA_LITE,
  BEDROCK_NOVA_MICRO,
  OLLAMA_LLAMA3,
  OLLAMA_MISTRAL,
] as const;

export type Model = (typeof ALL_MODELS)[number] | (string & {});

export function resolveModel(
  model: string | undefined,
  gemini31Launched: boolean,
  gemini31FlashLiteLaunched: boolean,
  isSea: boolean,
  hasAccessToPreview: boolean,
  config: Config,
): Model {
  if (model && model !== 'auto') {
    return model as Model;
  }

  // Fallback logic for 'auto'
  if (hasAccessToPreview) {
    return GEMINI_2_0_FLASH;
  }

  if (gemini31Launched) {
    return GEMINI_1_5_PRO;
  }

  return GEMINI_1_5_FLASH;
}
