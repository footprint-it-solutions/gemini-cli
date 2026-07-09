import { BedrockContentGenerator } from '../../../../packages/core/src/core/providers/bedrockProvider.js';
import * as path from 'path';

async function run() {
    process.env.AWS_CONFIG_FILE = path.resolve(process.cwd(), '.aws/config');
    process.env.AWS_PROFILE = 'Aerith-Development';
    process.env.AWS_SDK_LOAD_CONFIG = '1';

    console.log('=== Running Direct Bedrock Nova Micro Test ===');

    // Instantiate generator in Stockholm region (eu-north-1) where Nova models are primarily hosted in our setup, 
    // or eu-west-1 if that's what's in use. Let's use eu-west-1 first as that matches test_provider_direct.mjs.
    const generator = new BedrockContentGenerator('eu-west-1', 'Aerith-Development');

    const request = {
        model: 'bedrock/eu.amazon.nova-micro-v1:0',
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Respond with "Hello World".' }]
            }
        ],
        config: {
            temperature: 0,
            maxOutputTokens: 10,
        }
    };

    try {
        console.log('Calling generateContent for Nova Micro...');
        const response = await generator.generateContent(request);
        console.log('SUCCESS: Response received from Nova Micro:', JSON.stringify(response, null, 2));
    } catch (error) {
        console.error('FAIL: Direct Nova Micro invocation failed:', error);
    }
}

run();
