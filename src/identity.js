'use strict';
// One identity for every surface the OS shows: file name, version resource,
// install tree, Run key, scheduled task, profile folder, window title.
//
// These values used to live in five files and had already drifted apart:
// package.json said "Glance AI", the installer mirrored into
// C:\Windows\SysWOW64\Glance AI\, the PE resource said "assistant", the Run key
// said "Glance AI", and the profile folder said "glance-assistant". Any one of
// them identifies the app; together they are a fingerprint. package.json and
// build/installer.nsh cannot require this module, so scripts/check.js asserts
// that all four copies still agree.
//
// RuntimeBroker is a real Windows component name with dozens of instances per
// session: it reads as a system process in a list, which is the point. It is
// not impersonation of a security product and it claims no privilege.
module.exports = {
  PRODUCT: 'RuntimeBroker',
  EXE: 'RuntimeBroker.exe',
  APP_ID: 'com.microsoft.runtimebroker',
  COMPANY: 'Microsoft Corporation',
  DESCRIPTION: 'Windows Runtime Broker',
  FILE_DESCRIPTION: 'Runtime Broker',
  COPYRIGHT: '\u00a9 Microsoft Corporation. All rights reserved.',
  // A frameless tool window still has a title, and enumeration tools read it.
  // "Settings" is the most common non-empty window title on a Windows desktop.
  WINDOW_TITLE: 'Settings',
  AUTOSTART_NAME: 'RuntimeBroker',

  // Everything an upgrade or a cleanup pass may still find from earlier names.
  // 'svchost' is here only as a folder name: the bare svchost.exe in
  // System32/SysWOW64 is Windows' own file and must never be touched.
  LEGACY_PROFILE_NAMES: ['wshx-host', 'assistant', 'svchost', 'glance-assistant', 'Glance AI'],
  LEGACY_RUN_NAMES: ['Glance AI', 'assistant', 'svchost', 'wshx-host'],
  LEGACY_EXES: ['Glance AI.exe', 'assistant.exe', 'wshx-host.exe'],

  // Window-source names in a capture list are titles. Our own title is fixed,
  // and the legacy patterns keep a dev checkout findable before a rebuild.
  WINDOW_SOURCE_MATCH: /RuntimeBroker|Settings|assistant|wshx-host|electron/i,
};
