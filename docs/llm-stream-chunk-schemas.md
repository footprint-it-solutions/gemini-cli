Building stream adapters for **AWS Bedrock Nova** and **Ollama** requires
extracting text from completely different raw JSON shapes and data transmission
layers.  
Here is how to map and parse both of their chunk structures into a single, clean
format for your frontend.

## **1\. The Targets: Raw Chunk Schemas**

To write the adapter, you first need to see exactly what key holds the text
delta in both environments.

### **Bedrock Nova (ConverseStream)**

Bedrock emits events wrapped in various stream lifecycle objects. The text
chunks live deep inside the contentBlockDelta event object.

JSON  
{  
"contentBlockDelta": {  
"delta": {  
"text": "Hello"  
},  
"contentBlockIndex": 0  
}  
}

### **Ollama (/api/chat Endpoint)**

Ollama streams raw line-delimited JSON objects over a standard HTTP response.
The text chunk sits under message.content.

JSON  
{  
"model": "llama3.2",  
"created\_at": "2026-07-03T05:52:30Z",  
"message": {  
"role": "assistant",  
"content": "Hello"  
},  
"done": false  
}

## **2\. Implementing the Adapters (Node.js / TypeScript)**

Here is a clean implementation of the structural adapter pattern. It
standardizes both streams into a simple yield pattern that returns plain text
chunks.

TypeScript  
// Define a unified interface for your application client  
interface StreamAdapter {  
processChunk(rawChunk: any): string | null;  
isDone(rawChunk: any): boolean;  
}

/\*\*  
\* AWS Bedrock Nova Adapter  
\* Expects events from the @aws\-sdk/client-bedrock-runtime ConverseStream API  
\*/  
export class BedrockNovaAdapter implements StreamAdapter {  
processChunk(event: any): string | null {  
// Look strictly for the content block delta event type  
if (event && 'contentBlockDelta' in event) {  
return event.contentBlockDelta?.delta?.text || null;  
}  
return null;  
}

isDone(event: any): boolean {  
// Bedrock emits a final 'messageStop' event when complete  
return event && 'messageStop' in event;  
}  
}

/\*\*  
\* Ollama API Adapter  
\* Expects parsed JSON objects from Ollama's streaming endpoints  
\*/  
export class OllamaAdapter implements StreamAdapter {  
processChunk(chunk: any): string | null {  
if (chunk && chunk.message && chunk.message.content) {  
return chunk.message.content;  
}  
return null;  
}

isDone(chunk: any): boolean {  
return chunk && chunk.done \=== true;  
}  
}

## **3\. How to Consume Them in Your Pipeline**

Because you have abstracted the vendor layouts behind the StreamAdapter
interface, your core ingestion pipeline becomes dead simple.

TypeScript  
// Unified generator function that works with ANY adapter  
async function\* handleLLMStream(rawStream: AsyncIterable\<any\>, adapter:
StreamAdapter) {  
for await (const rawChunk of rawStream) {  
const text \= adapter.processChunk(rawChunk);  
if (text) {  
yield text; // Push clean string directly to UI/Client  
}

    if (adapter.isDone(rawChunk)) {
      break;
    }

}  
}

// \==========================================  
// Example 1: Wiring up AWS Bedrock  
// \==========================================  
import { BedrockRuntimeClient, ConverseStreamCommand } from
"@aws-sdk/client-bedrock-runtime";

const bedrock \= new BedrockRuntimeClient({ region: "us-east-1" });  
const command \= new ConverseStreamCommand({  
modelId: "us.amazon.nova-2-lite-v1:0",  
messages: \[{ role: "user", content: \[{ text: "Explain APIs" }\] }\]  
});

const response \= await bedrock.send(command);  
const novaCleanStream \= handleLLMStream(response.stream, new
BedrockNovaAdapter());

// \==========================================  
// Example 2: Wiring up Ollama  
// \==========================================  
import ollama from 'ollama';

const responseStream \= await ollama.chat({  
model: 'llama3.2',  
messages: \[{ role: 'user', content: 'Explain APIs' }\],  
stream: true  
});  
const ollamaCleanStream \= handleLLMStream(responseStream, new OllamaAdapter());

### **Things to watch out for:**

1. **Raw HTTP streams:** If you bypass the SDKs and hit Ollama's /api/chat via
   direct fetch, the chunks arrive as raw byte arrays. You will need to decode
   them (new TextDecoder().decode(chunk)) and parse the line-delimited JSON
   before feeding them to the OllamaAdapter.
2. **Metadata / Token metrics:** If you need to return usage metrics
   (input/output tokens) back to the UI along with the text, you can expand your
   adapter interface to check for Bedrock's 'metadata' event type or read
   Ollama's final chunk properties (eval\_count, total\_duration).
