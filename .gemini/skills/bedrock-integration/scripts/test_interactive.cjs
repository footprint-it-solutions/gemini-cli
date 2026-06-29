const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Automates testing of the Bedrock interactive mode to avoid requiring human intervention.
 */
async function runInteractiveTest() {
  console.log('--- Starting Automated Interactive Bedrock Test ---');
  
  const testFileName = 'test-bedrock-tool-output.txt';
  if (fs.existsSync(testFileName)) {
    fs.unlinkSync(testFileName);
  }

  const ptyProcess = spawn(process.execPath, ['bundle/gemini.js', '--model', 'bedrock/nova-lite'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AWS_PROFILE: 'Aerith-Development',
      GEMINI_CLI_HOME: path.join(process.cwd(), '.gemini-isolated')
    }
  });

  let output = '';
  let commandSent = false;
  
  ptyProcess.stdout.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    
    // Strip ANSI for easier matching
    const stripped = chunk.replace(/\x1B\[\d+m/g, '');
    
    if (stripped.includes('>') && !commandSent) {
      commandSent = true;
      console.log('\\n[TEST] Interactive prompt detected. Sending command...');
      ptyProcess.stdin.write(`Create the file ${testFileName} with the text "Hello from Bedrock"\n`);
    }
    
    if (stripped.toLowerCase().includes('api error') || stripped.includes('FAILURE') || stripped.includes('Expected toolResult blocks')) {
      console.log("\\n[TEST] CAUGHT ERROR FROM CLI:");
      console.log(stripped);
      ptyProcess.kill();
      process.exit(1);
    }
  });
  
  ptyProcess.stderr.on('data', (data) => {
    console.error(`[STDERR] ${data.toString()}`);
  });

  // wait 25 seconds for the entire turn to complete
  setTimeout(() => {
    console.log('\\n[TEST] Timeout reached. Verifying output...');
    
    if (fs.existsSync(testFileName)) {
        console.log(`[TEST] SUCCESS: ${testFileName} was created successfully!`);
        fs.unlinkSync(testFileName);
        ptyProcess.kill();
        process.exit(0);
    } else {
        console.log(`[TEST] FAILURE: ${testFileName} was NOT created.`);
        console.log('[TEST] Output dump:');
        console.log(output.replace(/\x1B\[\d+m/g, ''));
        ptyProcess.kill();
        process.exit(1);
    }
  }, 25000);
}

runInteractiveTest().catch(e => {
  console.error('[TEST] Script failed:', e);
  process.exit(1);
});
