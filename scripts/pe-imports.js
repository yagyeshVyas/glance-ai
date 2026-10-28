// Reads PE import tables + marker strings with no dependencies, to answer one
// question per binary: which screen-capture API family does it link?
//
//   node scripts/pe-imports.js <file> [<file> ...]
//
// Prints JSON: per file, the DLLs it imports, the capture-relevant functions, and raw
// hits for WinRT capture class names. Import presence is linkage evidence, not proof
// of a code path; the callers are named in the report so that limit stays visible.
'use strict';

const fs = require('fs');

const MARKERS = [
  'Windows.Graphics.Capture',
  'GraphicsCaptureItem',
  'GraphicsCaptureSession',
  'IDXGIOutputDuplication',
  'DeskDupl',
  'PrintWindow',
  'GetWindowDisplayAffinity',
  'SetWindowDisplayAffinity',
];

const FUNC_GROUPS = [
  ['display-affinity', /DisplayAffinity/i],
  ['window-enum', /^(EnumWindows|EnumDesktopWindows|EnumChildWindows|EnumThreadWindows)$/i],
  ['gdi-capture', /^(BitBlt|StretchBlt|PrintWindow|GetWindowDC|GetDC|CreateCompatibleDC|CreateCompatibleBitmap)$/i],
  ['dxgi', /^(CreateDXGIFactory|CreateDXGIFactory1|CreateDXGIFactory2|DXGIGetDebugInterface1?)$/i],
  ['d3d11', /^(D3D11CreateDevice|D3D11CreateDeviceAndSwapChain)$/i],
  ['dwm', /^(DwmGetWindowAttribute|DwmSetWindowAttribute|DwmFlush)$/i],
  ['magnification', /^(MagInitialize|MagSetWindowSource|MagSetWindowFilterList)$/i],
  ['winrt-activation', /^(RoActivateInstance|RoGetActivationFactory|WindowsCreateString|WindowsCreateStringReference)$/i],
];

function cstr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('latin1', off, end);
}

function parsePe(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not an MZ image');
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x4550) throw new Error('not a PE image');
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const is64 = magic === 0x20b;
  const dirOff = opt + (is64 ? 112 : 96);
  const impRva = buf.readUInt32LE(dirOff + 8);
  const secOff = opt + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = secOff + i * 40;
    sections.push({
      vsize: buf.readUInt32LE(off + 8),
      vaddr: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20),
    });
  }
  const rva2off = (rva) => {
    for (const s of sections) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return s.rawPtr + (rva - s.vaddr);
    }
    return -1;
  };
  const imports = {};
  let d = rva2off(impRva);
  for (let guard = 0; d > 0 && guard < 4096; guard++) {
    const oft = buf.readUInt32LE(d);
    const nameRva = buf.readUInt32LE(d + 12);
    const ft = buf.readUInt32LE(d + 16);
    if (!nameRva) break;
    const no = rva2off(nameRva);
    if (no < 0) break;
    const dll = cstr(buf, no);
    const thunk = rva2off(oft || ft);
    const funcs = [];
    if (thunk > 0) {
      const step = is64 ? 8 : 4;
      for (let i = 0; i < 20000; i++) {
        const at = thunk + i * step;
        if (at + step > buf.length) break;
        const raw = is64 ? buf.readBigUInt64LE(at) : BigInt(buf.readUInt32LE(at));
        if (raw === 0n) break;
        const ordFlag = is64 ? 0x8000000000000000n : 0x80000000n;
        if (raw & ordFlag) continue; // imported by ordinal: no name to report
        const ho = rva2off(Number(raw & 0x7fffffffn));
        if (ho < 0) continue;
        funcs.push(cstr(buf, ho + 2));
      }
    }
    imports[dll] = funcs;
    d += 20;
  }
  return { is64, imports };
}

function scanStrings(buf, needle) {
  const hits = [];
  for (const [enc, pat] of [
    ['ascii', Buffer.from(needle, 'latin1')],
    ['utf16le', Buffer.from(needle, 'utf16le')],
  ]) {
    let i = 0;
    let n = 0;
    while ((i = buf.indexOf(pat, i)) !== -1 && n < 8) {
      hits.push({ enc, off: i });
      i += pat.length;
      n++;
    }
  }
  return hits;
}

const report = [];
for (const file of process.argv.slice(2)) {
  try {
    const buf = fs.readFileSync(file);
    const { is64, imports } = parsePe(buf);
    const dlls = Object.keys(imports).sort();
    const groups = {};
    for (const [name, re] of FUNC_GROUPS) {
      const found = [];
      for (const [dll, funcs] of Object.entries(imports)) {
        for (const f of funcs) if (re.test(f)) found.push(`${dll}!${f}`);
      }
      if (found.length) groups[name] = [...new Set(found)].sort();
    }
    const markers = {};
    for (const m of MARKERS) {
      const hits = scanStrings(buf, m);
      if (hits.length) markers[m] = hits.length;
    }
    report.push({
      file,
      bytes: buf.length,
      arch: is64 ? 'x64' : 'x86',
      dllCount: dlls.length,
      captureDlls: dlls.filter((d) => /^(dxgi|d3d11|gdi32|user32|dwmapi|magnification|windows\.graphics|windows\.graphics\.capture|combase)\.dll$/i.test(d)),
      groups,
      markers,
    });
  } catch (err) {
    report.push({ file, error: err.message });
  }
}
console.log(JSON.stringify(report, null, 1));
