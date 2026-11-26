'use strict';
// electron-builder beforePack hook.
//
// The only native piece left is the OCR helper: Electron has no OCR API, so the
// app calls the in-box Windows engine through a small executable. Build it at
// package time so the shipped app never spawns a compiler and never writes an
// executable to %TEMP% on first run.
//
// The DWM-cloak addon, the window-class patcher and the C# stealth helper were
// removed in 3.3.7. Nothing in this hook compiles or ships them.

const path = require('path');

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // Fail the pack instead of shipping an installer whose extraResources entry
  // points at a file that was never built. The error names the real cause.
  const helper = require('./build-ocr-helper').build({ force: true });
  console.log('  • beforePack: OCR helper ready (' + path.basename(helper) + ')');
};
