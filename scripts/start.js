// Launch Electron with a clean env (a global NODE_OPTIONS like --openssl-legacy-provider makes Electron exit).
const { spawn } = require('child_process');
const electron = require('electron');
const env = { ...process.env };
delete env.NODE_OPTIONS;
spawn(electron, ['.'], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') })
  .on('exit', (c) => process.exit(c ?? 0));
