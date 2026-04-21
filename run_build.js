const { spawn } = require('child_process');

const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
const batFile = 'C:\\Users\\tzuri\\Desktop\\PAN\\do_build.bat';

console.log('Running build bat...');

const child = spawn(cmdExe, ['/c', batFile], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));

child.on('close', code => {
  console.log('\nBuild finished with code:', code);
  process.exit(code || 0);
});

child.on('error', err => {
  console.error('Spawn error:', err.message);
  process.exit(1);
});
