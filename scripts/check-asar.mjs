import asar from '@electron/asar';
import fs from 'fs';
const p = 'D:/cluelt clone/dist/win-unpacked/resources/app.asar';
for (const path of ['\\src\\renderer\\eye.js', '\\src\\main.js']) {
  const buf = asar.extractFile(p, path);
  const c = buf.toString('utf8');
  console.log('=== ' + path + ' ===');
  const m = c.match(/MP_BASE = [^\n]*/);
  console.log('MP_BASE:', m ? m[0] : '(n/a)');
  console.log('has mplocal://app/:', c.includes('mplocal://app/'));
  console.log('has protocol.handle:', c.includes('protocol.handle'));
  console.log('has renderer-diag:', c.includes('renderer-diag'));
  console.log('has fetchBytes:', c.includes('fetchBytes'));
  console.log('has ModuleFactory:', c.includes('ModuleFactory'));
}
