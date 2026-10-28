@echo off
rem Fast path for the detection audit. `npm run audit` adds ~0.6 s of npm startup
rem on Windows; this goes straight to node. Same arguments: audit.cmd --json
node "%~dp0scripts\detect-audit.js" %*
