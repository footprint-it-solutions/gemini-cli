/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { VllmAppRig } from '../packages/cli/src/test-utils/VllmAppRig.js';
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

export interface VllmAppEvalCase extends BaseEvalCase {
  suiteName: string;
  suiteType: 'behavioral' | 'component-level' | 'hero-scenario';
  configOverrides?: Record<string, any>;
  prompt: string;
  setup?: (rig: VllmAppRig) => Promise<void>;
  assert: (rig: VllmAppRig, output: string) => Promise<void>;
}

/**
 * A dedicated helper for running local vLLM provider behavioral evaluations using the in-process VllmAppRig.
 * This ensures no mock or test pollution on Gemini/Ollama-specific AppRig systems.
 */
export function vllmEvalTest(policy: EvalPolicy, evalCase: VllmAppEvalCase) {
  const fn = async () => {
    await withEvalRetries(evalCase.name, async () => {
      const rig = new VllmAppRig({
        configOverrides: {
          model: 'vllm/google/gemma-4-12B-it-qat-q4_0-unquantized', // Default local model
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
