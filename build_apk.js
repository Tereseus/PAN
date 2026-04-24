const { spawn } = require('child_process');

const androidDir = 'C:\\Users\\tzuri\\Desktop\\PAN\\android';
const javaHome = 'C:\\Program Files\\Android\\Android Studio\\jbr';
const cmdExe = 'C:\\Windows\\System32\\cmd.exe';

console.log('Starting Android build...');

const env = Object.assign({}, process.env, { JAVA_HOME: javaHome });

// Write a temp bat file to avoid quoting issues
const fs = require('fs');
const batContent = `@echo off\r\ncd /d ${androidDir}\r\ncall gradlew.bat assembleDebug\r\n`;
const batFile = 'C:\\Users\\tzuri\\Desktop\\PAN\\do_build.bat';
fs.writeFileSync(batFile, batContent);

console.log('Running:', batFile);

const child = spawn(cmdExe, ['/c', batFile], {
  env,
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
