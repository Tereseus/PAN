import { run, get } from './src/db.js';

async function main() {
  console.log('Force updating terminal settings to Gemini...');
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_ai_provider', '\"gemini\"')");
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_model', '\"gemini-1.5-pro\"')");
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_ai', '{\"provider\":\"gemini\",\"model\":\"gemini-1.5-pro\",\"custom_cmd\":\"\"}')");
  
  const provider = get("SELECT value FROM settings WHERE key = 'terminal_ai_provider'");
  console.log('Updated terminal_ai_provider:', provider);
}

main().catch(console.error);
