import { BedrockContentGenerator } from '../../../../packages/core/dist/src/core/providers/bedrockProvider.js';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  process.env.AWS_CONFIG_FILE = path.resolve(process.cwd(), '.aws/config');
  process.env.AWS_PROFILE = 'Aerith-Development';
  process.env.AWS_SDK_LOAD_CONFIG = '1';

  console.log('=== Running isolated direct Bedrock Provider Test ===');

  const generator = new BedrockContentGenerator(
    'eu-west-1',
    'Aerith-Development',
  );

  // 1. We construct a multi-turn conversation with write_file
  const request = {
    model: 'bedrock/eu.amazon.nova-2-lite-v1:0',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Create the file test-isolated.txt with the content "Hello from Bedrock"',
          },
        ],
      },
    ],
    config: {
      systemInstruction: {
        parts: [
          {
            text: 'You are a helpful software engineer. You MUST strictly use the tools available. Adhere to schemas.',
          },
        ],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'write_file',
              description:
                'Writes content to a specified file in the local filesystem.',
              parameters: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'The path to the file to write to.',
                  },
                  content: {
                    type: 'string',
                    description: 'The content to write.',
                  },
                },
                required: ['file_path', 'content'],
              },
            },
            {
              name: 'update_topic',
              description: 'Manages tactical intent.',
              parameters: {
                type: 'object',
                properties: {
                  strategic_intent: {
                    type: 'string',
                    description: 'A mandatory one-sentence intent.',
                  },
                },
                required: ['strategic_intent'],
              },
            },
          ],
        },
      ],
    },
  };

  console.log('Sending first user prompt...');
  try {
    const stream = await generator.generateContentStream(request);
    let firstTurnResponse = null;
    for await (const chunk of stream) {
      if (chunk.functionCalls) {
        console.log(
          'Model generated tool calls:',
          JSON.stringify(chunk.functionCalls, null, 2),
        );
        firstTurnResponse = chunk;
      }
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
        process.stdout.write(chunk.candidates[0].content.parts[0].text);
      }
    }
    console.log('\nFirst turn finished.');

    if (!firstTurnResponse || !firstTurnResponse.functionCalls) {
      console.error('FAIL: Model did not generate a tool call!');
      process.exit(1);
    }

    // Check if the generated tool calls are empty / missing args
    const call = firstTurnResponse.functionCalls[0];
    if (call.name === 'write_file' && (!call.args || !call.args.file_path)) {
      console.error(
        'FAIL: Model generated write_file tool call but it was MISSING arguments:',
        call.args,
      );
      process.exit(1);
    }

    console.log(
      'SUCCESS: First turn tool call arguments parsed correctly:',
      call.args,
    );

    // 2. Feed the tool result back into history
    console.log('Feeding tool result back and executing Turn 2...');
    const secondTurnRequest = {
      ...request,
      contents: [
        ...request.contents,
        // Add model's tool call part
        {
          role: 'model',
          parts: firstTurnResponse.candidates[0].content.parts,
        },
        // Add user's tool result part
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: call.name,
                response: {
                  output: 'Successfully wrote file test-isolated.txt',
                },
                id: call.id,
              },
            },
          ],
        },
      ],
    };

    const secondStream =
      await generator.generateContentStream(secondTurnRequest);
    for await (const chunk of secondStream) {
      if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
        process.stdout.write(chunk.candidates[0].content.parts[0].text);
      }
    }
    console.log('\nSecond turn finished successfully!');
    process.exit(0);
  } catch (e) {
    console.error('CRASH:', e);
    process.exit(1);
  }
}

run();
