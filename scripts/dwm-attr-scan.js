// plain `node` cannot use the Electron API: re-exec under the bundled binary
const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  process.exit(spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1);
}

const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const crypto = require('crypto'); const path=require('path');
const nat = require(path.join(__dirname,'..','src','native',process.arch,'cloak.node'));
const hwndOf=w=>w.getNativeWindowHandle().readUInt32LE(0);
async function h(rect){const d=screen.getPrimaryDisplay();const s=d.scaleFactor||1;
const src=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(d.size.width*s),height:Math.round(d.size.height*s)}});
const img=src[0].thumbnail,b=img.toBitmap(),W=img.getSize().width;const px=v=>Math.round(v*s);
const x0=px(rect.x+40),y0=px(rect.y+40),w=Math.min(px(180),W-x0),hh=Math.min(px(120),img.getSize().height-y0);
const H=crypto.createHash('sha256');for(let r=0;r<hh;r++){const st=((y0+r)*W+x0)*4;H.update(b.subarray(st,st+w*4));}return H.digest('hex').slice(0,16);}
app.whenReady().then(async()=>{
 const win=new BrowserWindow({x:180,y:180,width:700,height:500,frame:false,transparent:true,alwaysOnTop:true,skipTaskbar:true,hasShadow:false,backgroundColor:'#ff000000'});
 await win.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:#0b1020"><div style="height:150px;background:#e8453c"></div><div style="height:350px;background:#2f6fed"></div></body>'));
 win.showInactive();await new Promise(r=>setTimeout(r,1000));
 const child=hwndOf(win);const host=nat.attachHost(child).host;
 await new Promise(r=>setTimeout(r,700));const rect=win.getBounds();
 const vis=await h(rect);
 win.hide();await new Promise(r=>setTimeout(r,900));const hid=await h(rect);
 win.showInactive();await new Promise(r=>setTimeout(r,900));
 console.log('visible',vis,'hidden',hid);
 for(const id of [16,17,18,19,21,22,23,24,25,26,27,28,29,30,31,32,37,38,39,40]){
   const ok=nat.dwmAttr(host,id,1);await new Promise(r=>setTimeout(r,450));
   const v=await h(rect);
   const excludes = v===hid && vis!==hid;
   console.log(`attr ${id}: set=${ok} hash=${v} ${excludes?'  <== EXCLUDES':''}`);
   nat.dwmAttr(host,id,0);await new Promise(r=>setTimeout(r,150));
 }
 app.exit(0);});
