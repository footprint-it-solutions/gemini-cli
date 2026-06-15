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
  settings: any,
): Promise<string | null> {
  const methodStr = String(authMethod);
  // Simple passthrough for common methods
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    methodStr === 'oauth-personal' ||
    authMethod === AuthType.COMPUTE_ADC ||
    methodStr === 'compute-default-credentials' ||
    authMethod === AuthType.GATEWAY ||
    methodStr === 'gateway' ||
    authMethod === AuthType.OLLAMA ||
    methodStr === 'ollama'
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

  if (authMethod === AuthType.BEDROCK || methodStr === 'bedrock') {
    // Bedrock typically uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
    // or AWS_PROFILE, or IRSA (AWS_ROLE_ARN).
    // In some environments (like EC2/EKS), credentials might be provided
    // automatically by the environment if a region is specified.
    if (
      !process.env['AWS_ACCESS_KEY_ID'] &&
      !process.env['AWS_PROFILE'] &&
      !process.env['AWS_ROLE_ARN'] &&
      !process.env['AWS_WEB_IDENTITY_TOKEN_FILE'] &&
      !process.env['BEDROCK_REGION'] &&
      !process.env['AWS_REGION']
    ) {
      return 'When using Bedrock, you must specify AWS credentials (e.g., AWS_ACCESS_KEY_ID, AWS_PROFILE, or AWS_ROLE_ARN) or an AWS region (AWS_REGION or BEDROCK_REGION).';
    }
    return null;
  }

  return 'Invalid auth method selected.';
}
