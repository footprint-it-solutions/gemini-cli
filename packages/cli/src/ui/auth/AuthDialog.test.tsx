/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type Mock,
} from 'vitest';
import { AuthDialog } from './AuthDialog.js';
import { AuthType } from '@google/gemini-cli-core';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { useInput, Text } from 'ink';
import { validateAuthMethod } from '../../config/auth.js';

// Mocks
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useInput: vi.fn(),
  };
});

vi.mock('../../config/auth.js', () => ({
  validateAuthMethod: vi.fn(),
}));

vi.mock('../components/shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: vi.fn(({ items, initialIndex }) => (
    <>
      {items.map((item: { value: string; label: string }, index: number) => (
        <Text key={item.value}>
          {index === initialIndex ? '(selected)' : '(not selected)'}{' '}
          {item.label}
        </Text>
      ))}
    </>
  )),
}));

const mockedUseInput = useInput as Mock;
const mockedRadioButtonSelect = RadioButtonSelect as Mock;
const mockedValidateAuthMethod = validateAuthMethod as Mock;

describe('AuthDialog', () => {
  let props: {
    onAuthSelected: Mock;
    onCancel: Mock;
    initialAuthType?: AuthType;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    props = {
      onAuthSelected: vi.fn(),
      onCancel: vi.fn(),
    };
  });

  it('renders with correct options', async () => {
    const { unmount } = await renderWithProviders(<AuthDialog {...props} />);
    const items = mockedRadioButtonSelect.mock.calls[0][0].items;
    
    expect(items.some((i: any) => i.value === AuthType.LOGIN_WITH_GOOGLE)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.USE_GEMINI)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.USE_VERTEX_AI)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.OPENAI)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.BEDROCK)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.OLLAMA)).toBe(true);
    expect(items.some((i: any) => i.value === AuthType.GATEWAY)).toBe(true);
    
    unmount();
  });

  it('uses initialAuthType for initial selection', async () => {
    props.initialAuthType = AuthType.USE_VERTEX_AI;
    const { unmount } = await renderWithProviders(<AuthDialog {...props} />);
    const { items, initialIndex } = mockedRadioButtonSelect.mock.calls[0][0];
    expect(items[initialIndex].value).toBe(AuthType.USE_VERTEX_AI);
    unmount();
  });

  it('defaults to LOGIN_WITH_GOOGLE if no initialAuthType is provided', async () => {
    const { unmount } = await renderWithProviders(<AuthDialog {...props} />);
    const { items, initialIndex } = mockedRadioButtonSelect.mock.calls[0][0];
    expect(items[initialIndex].value).toBe(AuthType.LOGIN_WITH_GOOGLE);
    unmount();
  });

  describe('handleSelect', () => {
    it('calls onAuthSelected if validation succeeds', async () => {
      mockedValidateAuthMethod.mockResolvedValue(null);
      const { unmount } = await renderWithProviders(<AuthDialog {...props} />);
      const { onSelect: handleSelect } = mockedRadioButtonSelect.mock.calls[0][0];
      
      await handleSelect({ value: AuthType.USE_GEMINI });

      expect(mockedValidateAuthMethod).toHaveBeenCalledWith(AuthType.USE_GEMINI);
      expect(props.onAuthSelected).toHaveBeenCalledWith(AuthType.USE_GEMINI);
      unmount();
    });

    it('displays error and does not call onAuthSelected if validation fails', async () => {
      mockedValidateAuthMethod.mockResolvedValue('Validation failed');
      const { lastFrame, unmount } = await renderWithProviders(<AuthDialog {...props} />);
      const { onSelect: handleSelect } = mockedRadioButtonSelect.mock.calls[0][0];
      
      await handleSelect({ value: AuthType.USE_GEMINI });

      expect(mockedValidateAuthMethod).toHaveBeenCalledWith(AuthType.USE_GEMINI);
      expect(props.onAuthSelected).not.toHaveBeenCalled();
      expect(lastFrame()).toContain('Validation failed');
      unmount();
    });
  });

  describe('Cancellation', () => {
    it('calls onCancel when ESC is pressed', async () => {
      const { unmount } = await renderWithProviders(<AuthDialog {...props} />);
      const useInputHandler = mockedUseInput.mock.calls[0][0];
      
      useInputHandler('', { escape: true });

      expect(props.onCancel).toHaveBeenCalled();
      unmount();
    });
  });

  describe('Snapshots', () => {
    it('renders correctly with default props', async () => {
      const { lastFrame, unmount } = await renderWithProviders(
        <AuthDialog {...props} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders correctly with validation error', async () => {
      mockedValidateAuthMethod.mockResolvedValue('Some validation error');
      const { lastFrame, unmount } = await renderWithProviders(
        <AuthDialog {...props} />,
      );
      const { onSelect: handleSelect } = mockedRadioButtonSelect.mock.calls[0][0];
      await handleSelect({ value: AuthType.USE_GEMINI });
      
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });
  });
});
