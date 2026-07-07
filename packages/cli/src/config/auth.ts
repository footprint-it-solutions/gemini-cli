/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, loadApiKey } from '@google/gemini-cli-core';

export async function validateAuthMethod(
  authMethod: AuthType,
): Promise<string | null> {
  return validateAuthMethodWithSettings(authMethod, undefined);
}

export async function validateAuthMethodWithSettings(
  authMethod: AuthType,
  _settings: unknown,
): Promise<string | null> {
  const methodStr = String(authMethod).toLowerCase();
  // Simple passthrough for common methods
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    methodStr === 'oauth-personal' ||
    authMethod === AuthType.COMPUTE_ADC ||
    methodStr === 'compute-default-credentials' ||
    authMethod === AuthType.GATEWAY ||
    methodStr === 'gateway' ||
    authMethod === AuthType.OLLAMA ||
    methodStr === 'ollama' ||
    authMethod === AuthType.OLLAMA_STREAMING ||
    methodStr === 'ollama-streaming'
  ) {
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI || methodStr === 'gemini-api-key') {
    const apiKey = await loadApiKey();
    if (!apiKey && !process.env['GEMINI_API_KEY']) {
      return (
        'When using Gemini API key, you must specify the GEMINI_API_KEY environment variable\n' +
        'or enter it in the setup dialog (no reload needed if using .env)!'
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI || methodStr === 'vertex-ai') {
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

  if (authMethod === AuthType.OPENAI || methodStr === 'openai') {
    if (!process.env['OPENAI_API_KEY']) {
      return 'When using OpenAI, you must specify the OPENAI_API_KEY environment variable.';
    }
    return null;
  }

  if (
    authMethod === AuthType.BEDROCK ||
    methodStr === 'bedrock' ||
    authMethod === AuthType.BEDROCK_NOVA ||
    methodStr === 'bedrock-nova'
  ) {
    // Bedrock typically uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
    // or AWS_PROFILE, or IRSA (AWS_ROLE_ARN).
    // In some environments (like EC2/EKS), credentials might be provided
    // automatically by the environment. We allow validation to pass to let
    // the AWS SDK attempt its full resolution chain.
    return null;
  }

  return `Invalid auth method selected: "${methodStr}". Expected one of: ${Object.values(
    AuthType,
  ).join(', ')}`;
}
