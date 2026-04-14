import { get, run } from './src/db.js';

async function main() {
  const provider = get("SELECT value FROM settings WHERE key = 'terminal_ai_provider'");
  console.log('Current terminal_ai_provider:', provider);

  const aiModel = get("SELECT value FROM settings WHERE key = 'ai_model'");
  console.log('Current ai_model:', aiModel);

  const terminalAi = get("SELECT value FROM settings WHERE key = 'terminal_ai'");
  console.log('Current terminal_ai:', terminalAi);
}

main().catch(console.error);
