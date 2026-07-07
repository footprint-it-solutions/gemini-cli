/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OllamaAppRig } from '../packages/cli/src/test-utils/OllamaAppRig.js';
import {
  type EvalPolicy,
  runEval,
  prepareLogDir,
  symlinkNodeModules,
  withEvalRetries,
  prepareWorkspace,
  type BaseEvalCase,
} from './test-helper.js';
import fs from 'node:fs';
import path from 'node:path';

export interface OllamaAppEvalCase extends BaseEvalCase {
  configOverrides?: Record<string, any>;
  prompt: string;
  setup?: (rig: OllamaAppRig) => Promise<void>;
  assert: (rig: OllamaAppRig, output: string) => Promise<void>;
}

/**
 * A dedicated helper for running local Ollama provider behavioral evaluations using the in-process OllamaAppRig.
 * This ensures no mock or test pollution on Gemini-specific AppRig systems.
 */
export function ollamaEvalTest(
  policy: EvalPolicy,
  evalCase: OllamaAppEvalCase,
) {
  const fn = async () => {
    await withEvalRetries(evalCase.name, async () => {
      const rig = new OllamaAppRig({
        configOverrides: {
          model: 'ollama/qwen3-coder:30b', // Default local model
          ...evalCase.configOverrides,
        },
      });

      const { logDir, sanitizedName } = await prepareLogDir(evalCase.name);
      const logFile = path.join(logDir, `${sanitizedName}.log`);

      try {
        await rig.initialize();

        const testDir = rig.getTestDir();
        symlinkNodeModules(testDir);

        // Setup initial files
        if (evalCase.files) {
          await prepareWorkspace(testDir, testDir, evalCase.files);
        }

        // Run custom setup if provided (e.g. for breakpoints)
        if (evalCase.setup) {
          await evalCase.setup(rig);
        }

        // Render the app!
        await rig.render();

        // Wait for initial ready state
        await rig.waitForIdle();

        // Send the initial prompt
        await rig.sendMessage(evalCase.prompt);

        // Run assertion.
        const output = rig.getStaticOutput();
        await evalCase.assert(rig, output);
      } finally {
        const output = rig.getStaticOutput();
        if (output) {
          await fs.promises.writeFile(logFile, output);
        }
        await rig.unmount();
      }
    });
  };

  runEval(policy, evalCase, fn, (evalCase.timeout ?? 60000) + 10000);
}
