// PAN Claude Runner — bridges PAN service to the local Claude Code CLI
// This does NOT use the Anthropic API directly. It shells out to the locally
// installed Claude Code CLI (`claude -p`), which handles its own auth via
// the user's Claude Code subscription. No API key needed.
//
// Called by: src/claude.js (which is used by router.js for intent handling)
// Flow: PAN service -> claude.js -> this runner -> claude CLI -> response

const { execSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');

const promptFile = process.argv[2];
const outputFile = process.argv[3];
const model = process.argv[4] || 'sonnet';

try {
  const prompt = readFileSync(promptFile, 'utf-8');

  const result = execSync(
    `"${process.env.APPDATA}\\npm\\claude.cmd" -p --model ${model}`,
    {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024
    }
  );

  writeFileSync(outputFile, result || '');
} catch (e) {
  writeFileSync(outputFile, 'PAN_ERROR:' + (e.stderr || e.message));
}
