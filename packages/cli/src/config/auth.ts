/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, loadApiKey } from '@google/gemini-cli-core';
import { loadEnvironment, loadSettings } from './settings.js';

export async function validateAuthMethod(
  authMethod: AuthType,
): Promise<string | null> {
  return validateAuthMethodWithSettings(authMethod, undefined);
}

export async function validateAuthMethodWithSettings(
  authMethod: AuthType,
  settings: any,
): Promise<string | null> {
  // Simple passthrough for common methods
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    authMethod === AuthType.COMPUTE_ADC ||
    authMethod === AuthType.GATEWAY ||
    authMethod === AuthType.OLLAMA
  ) {
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    const apiKey = await loadApiKey();
    if (!apiKey && !process.env['GEMINI_API_KEY']) {
      return (
        'When using Gemini API key, you must specify the GEMINI_API_KEY environment variable\n' +
        'or enter it in the setup dialog (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasVertexProjectLocationConfig =
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION'];
    const hasGoogleApiKey = !!process.env['GOOGLE_API_KEY'];
    if (!hasVertexProjectLocationConfig && !hasGoogleApiKey) {
      return (
        'When using Vertex AI, you must specify either:\n' +
        '• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n' +
        '• GOOGLE_API_KEY environment variable (if using express mode).\n' +
        'Update your environment and try again (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.OPENAI) {
    if (!process.env['OPENAI_API_KEY']) {
      return 'When using OpenAI, you must specify the OPENAI_API_KEY environment variable.';
    }
    return null;
  }

  if (authMethod === AuthType.BEDROCK) {
    // Bedrock typically uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
    // or AWS_PROFILE, or IRSA (AWS_ROLE_ARN).
    if (
      !process.env['AWS_ACCESS_KEY_ID'] &&
      !process.env['AWS_PROFILE'] &&
      !process.env['AWS_ROLE_ARN'] &&
      !process.env['AWS_WEB_IDENTITY_TOKEN_FILE']
    ) {
      return 'When using Bedrock, you must specify AWS credentials (e.g., AWS_ACCESS_KEY_ID, AWS_PROFILE, or AWS_ROLE_ARN).';
    }
    return null;
  }

  if (authMethod === AuthType.OLLAMA) {
    // Ollama doesn't strictly require a base URL in env if it's running on localhost:11434
    return null;
  }

  return 'Invalid auth method selected.';
}
