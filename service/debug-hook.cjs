const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const log = {
      time: new Date().toISOString(),
      cwd: process.cwd(),
      env_path: process.env.PATH ? process.env.PATH.substring(0, 500) : 'NO PATH',
      stdin: input,
      argv: process.argv,
      platform: process.platform,
      node_version: process.version
    };
    fs.writeFileSync(
      path.join(process.env.USERPROFILE || 'C:\\Users\\tzuri', 'hook-debug.json'),
      JSON.stringify(log, null, 2)
    );
  } catch (e) {
    fs.writeFileSync(
      path.join(process.env.USERPROFILE || 'C:\\Users\\tzuri', 'hook-debug-error.txt'),
      e.stack || e.message || String(e)
    );
  }
  process.exit(0);
});
