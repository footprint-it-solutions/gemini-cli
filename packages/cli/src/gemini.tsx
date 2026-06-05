/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type StartupWarning,
  WarningPriority,
  type Config,
  type ResumedSessionData,
  type WorktreeInfo,
  type OutputPayload,
  SettingScope,
  AuthType,
  getAuthTypeFromEnv,
} from '@google/gemini-cli-core';
import type { RemoteAdminSettings } from '@google/gemini-cli-core';
import { run, type CliHandle } from './src/index.js';
import { loadSettings } from './src/config/settings.js';
import { loadCliConfig } from './src/config/config.js';
import dns from 'node:dns';

/**
 * Validates the DNS resolution order setting.
 * @param order The DNS resolution order string.
 * @returns The validated DNS resolution order.
 */
function validateDnsResolutionOrder(
  order: string | undefined,
): 'verbatim' | 'ipv4first' {
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  return 'verbatim';
}

/**
 * Main entry point for the Gemini CLI when run as a library.
 * This function initializes settings and config before calling the main run loop.
 */
export async function startCli(
  sessionId: string,
  argv: string[],
  worktreeInfo: WorktreeInfo,
): Promise<CliHandle> {
  const settings = await loadSettings();

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced.dnsResolutionOrder),
  );

  // Prefer auth type from environment if present, overriding configured settings
  const envAuthType = getAuthTypeFromEnv();
  if (envAuthType && envAuthType !== settings.merged.security.auth.selectedType) {
    settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      envAuthType,
    );
  }

  const partialConfig = await loadCliConfig(settings.merged, sessionId, argv, {
    projectHooks: settings.workspace.settings.hooks,
    skipExtensions: true,
  });

  let config: Config | null = null;
  let pendingSettings: RemoteAdminSettings | null = null;

  const messageHandler = (message: any) => {
    if (message.type === 'SET_REMOTE_ADMIN_SETTINGS') {
      if (config) {
        config.setRemoteAdminSettings(message.settings);
      } else {
        pendingSettings = message.settings;
      }
    }
  };

  process.on('message', messageHandler);

  const { cleanup } = run({
    sessionId,
    argv,
    config: partialConfig,
    worktreeInfo,
    onOutput: (payload: OutputPayload) => {
      if (process.send) {
        process.send({ type: 'OUTPUT', payload });
      }
    },
    onStartupWarning: (warning: StartupWarning) => {
      if (process.send) {
        process.send({ type: 'STARTUP_WARNING', warning });
      }
    },
    onSessionResumed: (data: ResumedSessionData) => {
      if (process.send) {
        process.send({ type: 'SESSION_RESUMED', data });
      }
    },
  });

  return {
    updateConfig: (newConfig: Config) => {
      config = newConfig;
      if (pendingSettings) {
        config.setRemoteAdminSettings(pendingSettings);
      }
    },
    cleanup: () => {
      process.off('message', messageHandler);
    },
  };
}
