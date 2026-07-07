import { OllamaContentGenerator } from '../../../../packages/core/dist/src/core/providers/ollamaProvider.js';

async function run() {
    const modelName = process.env.OLLAMA_MODEL || 'qwen3-coder:30b';
    console.log(`=== Running isolated direct Ollama Provider Test ===`);
    console.log(`Testing model: ${modelName}`);

    const generator = new OllamaContentGenerator({
        baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434',
        temperature: 0.1,
    });

    // 1. We construct a multi-turn conversation with write_file using UPPERCASE types to test conversion
    const request = {
        model: `ollama/${modelName}`,
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Create the file test-ollama-isolated.txt with the content "Hello from Ollama!"' }]
            }
        ],
        config: {
            systemInstruction: { parts: [{ text: 'You are a helpful software engineer. You MUST strictly use the tools available. Adhere to schemas.' }] },
            tools: [{
                functionDeclarations: [
                    {
                        name: 'write_file',
                        description: 'Writes content to a specified file in the local filesystem.',
                        parameters: {
                            type: 'OBJECT', // Testing uppercase-to-lowercase schema translation
                            properties: {
                                file_path: { type: 'STRING', description: 'The path to the file to write to.' },
                                content: { type: 'STRING', description: 'The content to write.' }
                            },
                            required: ['file_path', 'content']
                        }
                    },
                    {
                        name: 'update_topic',
                        description: 'Manages tactical intent.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                strategic_intent: { type: 'STRING', description: 'A mandatory one-sentence intent.' }
                            },
                            required: ['strategic_intent']
                        }
                    }
                ]
            }]
        }
    };

    console.log('Sending first user prompt and checking tools translation & streaming bypass...');
    try {
        const stream = await generator.generateContentStream(request);
        let firstTurnResponse = null;
        let chunksCount = 0;

        for await (const chunk of stream) {
            chunksCount++;
            if (chunk.candidates?.[0]?.content?.parts) {
                const parts = chunk.candidates[0].content.parts;
                const toolCalls = parts.filter(p => p.functionCall);
                if (toolCalls.length > 0) {
                    firstTurnResponse = { functionCalls: toolCalls.map(p => p.functionCall) };
                }
                
                const textPart = parts.find(p => p.text);
                if (textPart && textPart.text) {
                    process.stdout.write(textPart.text);
                }
            }
        }
        console.log('\nFirst turn finished.');
        console.log(`Stream chunks received: ${chunksCount} (Should be exactly 1 due to streaming bypass on tools)`);

        if (chunksCount !== 1) {
            console.warn('WARNING: Received multiple stream chunks. Ensure streaming-bypass is working properly.');
        } else {
            console.log('SUCCESS: Streaming bypass successfully constrained request to 1 chunk.');
        }

        if (!firstTurnResponse || !firstTurnResponse.functionCalls) {
            console.error('FAIL: Model did not generate a tool call! Check if the model is pulled and supports tools.');
            process.exit(1);
        }

        // Check if the generated tool calls are empty / missing args
        const call = firstTurnResponse.functionCalls[0];
        if (call.name === 'write_file' && (!call.args || !call.args.file_path)) {
            console.error('FAIL: Model generated write_file tool call but it was MISSING arguments:', call.args);
            process.exit(1);
        }

        console.log('SUCCESS: First turn tool call arguments parsed correctly:', call.args);

        // 2. Feed the tool result back into history
        console.log('Feeding tool result back and executing Turn 2...');
        const secondTurnRequest = {
            ...request,
            contents: [
                ...request.contents,
                // Add model's tool call part
                {
                    role: 'model',
                    parts: [
                        {
                            functionCall: {
                                name: call.name,
                                args: call.args,
                                id: call.id
                            }
                        }
                    ]
                },
                // Add user's tool result part
                {
                    role: 'user',
                    parts: [
                        {
                            functionResponse: {
                                name: call.name,
                                response: { output: 'Successfully wrote file test-ollama-isolated.txt' },
                                id: call.id
                            }
                        }
                    ]
                }
            ]
        };

        const secondStream = await generator.generateContentStream(secondTurnRequest);
        for await (const chunk of secondStream) {
            if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
                process.stdout.write(chunk.candidates[0].content.parts[0].text);
            }
        }
        console.log('\nSecond turn finished successfully!');
        process.exit(0);

    } catch (e) {
        console.error('CRASH:', e);
        console.log('\nTips for troubleshooting:');
        console.log(`1. Ensure Ollama is running locally at http://localhost:11434`);
        console.log(`2. Ensure you have pulled the model using 'ollama pull ${modelName}'`);
        process.exit(1);
    }
}

run();
