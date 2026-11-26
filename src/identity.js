'use strict';
// One identity for every surface the OS shows: file name, version resource,
// install tree, Run key, scheduled task, profile folder, window title.
//
// This is the product's own name now. Earlier builds shipped as RuntimeBroker,
// a real Windows component name chosen so a process list would read as a system
// process; that is gone. Impersonating a Windows component is a detection
// signal of its own (path does not match System32, signer does not match the
// version resource), and it is not this product's name. Glance AI is.
//
// package.json and build/installer.nsh cannot require this module, so
// scripts/check.js asserts that all copies still agree.

module.exports = {
  PRODUCT: 'Glance AI',
  EXE: 'GlanceAI.exe',
  APP_ID: 'ai.glance.desktop',
  COMPANY: 'Glance AI',
  DESCRIPTION: 'Glance AI desktop assistant',
  FILE_DESCRIPTION: 'Glance AI',
  COPYRIGHT: '\u00a9 Glance AI. All rights reserved.',
  WINDOW_TITLE: 'Glance AI',
  AUTOSTART_NAME: 'Glance AI',

  // Everything an upgrade or a cleanup pass may still find from earlier names.
  // 'svchost' is here only as a folder name: the bare svchost.exe in
  // System32/SysWOW64 is Windows' own file and must never be touched.
  // RuntimeBroker is the identity this build replaces.
  LEGACY_PROFILE_NAMES: ['wshx-host', 'assistant', 'svchost', 'glance-assistant', 'RuntimeBroker'],
  LEGACY_RUN_NAMES: ['RuntimeBroker', 'assistant', 'svchost', 'wshx-host'],
  LEGACY_EXES: ['RuntimeBroker.exe', 'assistant.exe', 'wshx-host.exe'],

  // Window-source names in a capture list are titles. Legacy patterns keep a
  // dev checkout findable after a rename.
  WINDOW_SOURCE_MATCH: /Glance ?AI|RuntimeBroker|assistant|wshx-host|electron/i,
};
