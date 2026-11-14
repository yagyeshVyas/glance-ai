// Lists the video capture devices Chromium sees, and optionally opens one to
// report the frame size it actually delivers. Chromium's device layer is the
// same code path Chrome uses, so this is the probe for "will a virtual camera
// show up in a browser / Meet / Teams-style app on this machine".
//
// Run: npx electron scripts/camera-probe.js [--match <substring>]
'use strict';

const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  process.exit(spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1);
}

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const holdArg = (() => {
  const i = process.argv.indexOf('--hold');
  return i >= 0 ? Number(process.argv[i + 1]) || 2 : 2;
})();

const matchArg = (() => {
  const i = process.argv.indexOf('--match');
  return i >= 0 ? process.argv[i + 1] : '';
})();

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'videoCapture');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'media' || permission === 'videoCapture');

  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL('file:///' + process.env.TEMP.replace(/\\/g,'/') + '/vcam-probe.html');

  const script = `
    (async () => {
      const out = { devices: [], opened: null, error: null };
      try {
        // labels are hidden until the page has been granted camera access once;
        // open the default camera briefly, then stop it
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          s.getTracks().forEach((t) => t.stop());
        } catch (e) { out.error = 'permission: ' + (e && e.name); }
        const list = await navigator.mediaDevices.enumerateDevices();
        out.devices = list.filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: d.label }));
        const want = ${JSON.stringify(matchArg)};
        const pick = want
          ? out.devices.find((d) => d.label.toLowerCase().includes(want.toLowerCase()))
          : out.devices.find((d) => !/integrated|usb|hd user|facetime|webcam/i.test(d.label));
        if (pick) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: pick.id } }, audio: false });
          const v = document.createElement('video');
          v.muted = true; v.playsInline = true; v.srcObject = stream;
          await v.play();
          await new Promise((r) => setTimeout(r, ${holdArg} * 1000));
          let pixel = null;
          if (v.videoWidth && v.videoHeight) {
            const c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            const ctx = c.getContext('2d');
            ctx.drawImage(v, 0, 0);
            const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
            pixel = [d[0], d[1], d[2], d[3]];
            out.png = c.toDataURL('image/png');
            // two frames, 700 ms apart: a live camera always differs, a static
            // placeholder image is byte-identical
            const a = ctx.getImageData(0, 0, c.width, c.height).data;
            await new Promise((r) => setTimeout(r, 700));
            ctx.drawImage(v, 0, 0);
            const b = ctx.getImageData(0, 0, c.width, c.height).data;
            let sum = 0, n = 0;
            for (let i = 0; i < a.length; i += 4 * 101) {
              sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
              n++;
            }
            out.motion = n ? +(sum / n).toFixed(2) : null;
          }
          out.opened = { label: pick.label, width: v.videoWidth, height: v.videoHeight, readyState: v.readyState, centrePixel: pixel };
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      return out;
    })()
  `;
  let result;
  try { result = await win.webContents.executeJavaScript(script); }
  catch (e) { result = { error: String(e && e.message) }; }
  if (result && result.png) {
    const png = path.join(require('os').tmpdir(), 'vcam-probe.png');
    try {
      fs.writeFileSync(png, Buffer.from(String(result.png).split(',')[1], 'base64'));
      result.png = png;
    } catch {}
  }
  console.log(JSON.stringify(result, null, 1));
  app.quit();
});



