Handling streaming **Tool Calls** (Function Calling) introduces a major
challenge: while text can be rendered sequentially character-by-character, tool
arguments arrive as a broken stream of a JSON string (e.g., {"loc, ation":,
"Lon, don"}).  
The client cannot reliably use a tool call until the full JSON argument string
has completely arrived and been aggregated.

## **1\. The Strategy: Two Output Paths**

Your stream adapter must now separate data into two discrete tracks:

1. **Text chunks:** Streamed instantly to the client UI.
2. **Tool call blocks:** Accumulated, reconstructed, and delivered only when the
   block completes (or parsed progressively using an incremental JSON parser).

## **2\. The Raw Stream Shapes for Tools**

### **AWS Bedrock Nova**

Bedrock signals tool calls over multiple stream events using contentBlockStart,
contentBlockDelta, and contentBlockStop.

JSON  
// Event 1: The model declares it is opening a tool block  
{  
"contentBlockStart": {  
"start": { "toolUse": { "toolUseId": "tool\_1", "name": "get\_weather" } },  
"contentBlockIndex": 1  
}  
}

// Event 2..N: Incremental pieces of the JSON string arguments argument  
{  
"contentBlockDelta": {  
"delta": { "toolUse": { "input": "{\\"location\\": \\"Lon" } },  
"contentBlockIndex": 1  
}  
}

### **Ollama**

Ollama updates an ongoing array inside message.tool\_calls. The arguments object
dynamically aggregates as chunks arrive.

JSON  
{  
"message": {  
"role": "assistant",  
"tool\_calls": \[  
{  
"function": {  
"name": "get\_weather",  
"arguments": { "location": "London" }  
}  
}  
\]  
},  
"done": false  
}

## **3\. Upgrading the Code (TypeScript)**

Let's design a unified wrapper that manages the chunk data cleanly, storing tool
arguments as they stream in.

### **Step 1: Define a Unified Event Shape**

TypeScript  
export interface StreamOutput {  
type: 'text' | 'tool\_call';  
content?: string; // Used for text deltas  
toolCall?: { // Used for completed tool payloads  
id?: string;  
name: string;  
arguments: any; // Fully parsed object  
};  
}

### **Step 2: The Upgraded Adapters**

TypeScript  
export class BedrockNovaToolAdapter {  
private currentTool: { id?: string; name: string; rawArgs: string } | null \=
null;

processChunk(event: any): StreamOutput | null {  
// 1\. Tool Call Starts  
if (event.contentBlockStart?.start?.toolUse) {  
const toolUse \= event.contentBlockStart.start.toolUse;  
this.currentTool \= {  
id: toolUse.toolUseId,  
name: toolUse.name,  
rawArgs: ''  
};  
return null;  
}

    // 2\. Tool Arguments Stream (Accumulating strings)
    if (event.contentBlockDelta?.delta?.toolUse) {
      if (this.currentTool) {
        this.currentTool.rawArgs \+= event.contentBlockDelta.delta.toolUse.input;
      }
      return null;
    }

    // 3\. Tool Call Ends (Emit full object)
    if (event.contentBlockStop && this.currentTool) {
      const completedTool \= {
        type: 'tool\_call' as const,
        toolCall: {
          id: this.currentTool.id,
          name: this.currentTool.name,
          arguments: JSON.parse(this.currentTool.rawArgs || '{}')
        }
      };
      this.currentTool \= null; // Reset state
      return completedTool;
    }

    // 4\. Standard Text Fallback
    if (event.contentBlockDelta?.delta?.text) {
      return { type: 'text', content: event.contentBlockDelta.delta.text };
    }

    return null;

}  
}

export class OllamaToolAdapter {  
private emittedTools \= new Set\<string\>();

processChunk(chunk: any): StreamOutput | null {  
const toolCalls \= chunk.message?.tool\_calls;

    // Ollama streams fully formed arguments up to that point or on completion
    if (toolCalls && toolCalls.length \> 0 && chunk.done) {
      const tool \= toolCalls\[0\]; // Take primary tool call
      const uniqueKey \= \`${tool.function.name}-${JSON.stringify(tool.function.arguments)}\`;

      if (\!this.emittedTools.has(uniqueKey)) {
        this.emittedTools.add(uniqueKey);
        return {
          type: 'tool\_call',
          toolCall: {
            name: tool.function.name,
            arguments: tool.function.arguments // Ollama often auto-parses this to an object
          }
        };
      }
    }

    // Standard Text Fallback
    if (chunk.message?.content) {
      return { type: 'text', content: chunk.message.content };
    }

    return null;

}  
}

## **4\. Consuming the New Unified Output**

Your pipeline routing logic can now make easy execution choices depending on the
output type.

TypeScript  
async function handlePipeline(stream: AsyncIterable\<any\>, adapter: any) {  
for await (const chunk of stream) {  
const output \= adapter.processChunk(chunk);

    if (\!output) continue;

    if (output.type \=== 'text') {
      // Stream text directly to front-end components
      process.stdout.write(output.content);
    }

    else if (output.type \=== 'tool\_call' && output.toolCall) {
      console.log(\`\\n\[Executing Tool\]: ${output.toolCall.name}\`);
      // Execute local function logic:
      // const result \= await myLocalTools\[output.toolCall.name\](output.toolCall.arguments);
    }

}  
}

**Pro-Tip on Streaming JSON:** If you want your client to see what tool
arguments are being typed out _as they stream_ (e.g., watching a map parameter
generate coordinates live), use a package like partial-json-parser on
this.currentTool.rawArgs inside the delta block. This allows you to safely pass
a broken JSON string to JSON.parse() without crashing your pipeline.
