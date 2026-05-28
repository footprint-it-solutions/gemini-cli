/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@google/gemini-cli-core';
import { Box, Text, useInput } from 'ink';
import { useState, useCallback } from 'react';
import { SelectionList } from '../components/SelectionList.js';
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
  const [selectedType, setSelectedType] = useState<AuthType>(
    initialAuthType || AuthType.LOGIN_WITH_GOOGLE,
  );
  const [error, setError] = useState<string | null>(null);

  const authOptions = [
    {
      label: 'Log in with Google (OAuth)',
      value: AuthType.LOGIN_WITH_GOOGLE,
    },
    {
      label: 'Gemini API Key',
      value: AuthType.USE_GEMINI,
    },
    {
      label: 'Vertex AI (GCP)',
      value: AuthType.USE_VERTEX_AI,
    },
    {
      label: 'OpenAI API',
      value: AuthType.OPENAI,
    },
    {
      label: 'Amazon Bedrock',
      value: AuthType.BEDROCK,
    },
    {
      label: 'Ollama (Local)',
      value: AuthType.OLLAMA,
    },
    {
      label: 'AI API Gateway',
      value: AuthType.GATEWAY,
    },
  ];

  const handleSelect = useCallback(
    async (item: { value: AuthType }) => {
      const validationError = await validateAuthMethod(item.value);
      if (validationError) {
        setError(validationError);
        return;
      }
      onAuthSelected(item.value);
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

      <SelectionList
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
