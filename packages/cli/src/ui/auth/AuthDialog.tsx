/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@google/gemini-cli-core';
import { Box, Text, useInput } from 'ink';
import { useState, useCallback } from 'react';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { validateAuthMethod } from '../../config/auth.js';

export interface AuthDialogProps {
  onAuthSelected: (authType: AuthType, apiKey?: string) => void;
  onCancel: () => void;
  initialAuthType?: AuthType;
}

export function AuthDialog({
  onAuthSelected,
  onCancel,
  initialAuthType,
}: AuthDialogProps) {
  const [selectedType] = useState<AuthType>(
    initialAuthType || AuthType.LOGIN_WITH_GOOGLE,
  );
  const [error, setError] = useState<string | null>(null);

  const authOptions = [
    {
      key: 'google',
      label: 'Log in with Google (OAuth)',
      value: AuthType.LOGIN_WITH_GOOGLE,
    },
    {
      key: 'gemini',
      label: 'Gemini API Key',
      value: AuthType.USE_GEMINI,
    },
    {
      key: 'vertex',
      label: 'Vertex AI (GCP)',
      value: AuthType.USE_VERTEX_AI,
    },
    {
      key: 'openai',
      label: 'OpenAI API',
      value: AuthType.OPENAI,
    },
    {
      key: 'bedrock',
      label: 'Amazon Bedrock',
      value: AuthType.BEDROCK,
    },
    {
      key: 'ollama',
      label: 'Ollama (Local)',
      value: AuthType.OLLAMA,
    },
    {
      key: 'gateway',
      label: 'AI API Gateway',
      value: AuthType.GATEWAY,
    },
  ];

  const handleSelect = useCallback(
    async (authType: AuthType) => {
      const validationError = await validateAuthMethod(authType);
      if (validationError) {
        setError(validationError);
        return;
      }
      onAuthSelected(authType);
    },
    [onAuthSelected],
  );

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Box marginBottom={1}>
        <Text bold>Select Authentication Method</Text>
      </Box>

      <RadioButtonSelect
        items={authOptions}
        onSelect={handleSelect}
        initialIndex={authOptions.findIndex((o) => o.value === selectedType)}
      />

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press ESC to cancel</Text>
      </Box>
    </Box>
  );
}
