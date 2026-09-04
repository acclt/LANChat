// Inspect the packaged WebView through its local debug endpoint, without saving preferences.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'artifacts/desktop-ui/native');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  fs.mkdirSync(output,{recursive:true});
  let page;
  for(let i=0;i<60&&!page;i++){
    try{page=(await(await fetch('http://127.0.0.1:19340/json/list')).json()).find(p=>p.type==='page'&&p.title==='LQ Chat');}catch{}
    if(!page)await sleep(500);
  }
  assert(page,'Packaged WebView did not start');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let id=0;const pending=new Map(),errors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error||m.result?.exceptionDetails?p.reject(m.error||m.result.exceptionDetails):p.resolve(m.result);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  const click=async selector=>{
    const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!n.contains(document.elementFromPoint(x,y)))throw Error('Control covered');return{x,y};})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await sleep(250);
  };
  const shot=async name=>{const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
  try{
    await send('Runtime.enable');
    for(let i=0;i<40;i++){if(await evaluate(`!!window.NotificationUI&&document.body.classList.contains('windows-app')&&!!document.querySelector('.ns-welcome')`))break;await sleep(250);}
    const before=await evaluate(`apiGetSettings()`);
    for(const file of ['css/desktop-ui.css','js/app.js','js/ui.js','js/notification-sync.js']){
      const text=await evaluate(`fetch(${JSON.stringify(file)}).then(r=>r.text())`);
      const hash=t=>crypto.createHash('sha256').update(t.replace(/\r\n/g,'\n')).digest('hex');
      assert.equal(hash(text),hash(fs.readFileSync(path.join(root,'src',file),'utf8')),file+' not embedded in executable');
    }
    assert(await evaluate(`!!document.getElementById('desktop-ui-stylesheet') && !!document.querySelector('.desktop-brand') && !!document.querySelector('#attach-file-btn svg')`),'Packaged HTML must include the desktop controls');
    await shot('home');
    await click('#settings-btn');
    const state=await evaluate(`(()=>{const visible=id=>!!document.getElementById(id)?.getClientRects().length;return{width:innerWidth,height:innerHeight,settings:visible('settings-panel'),tray:visible('close-to-tray-toggle'),autostart:visible('autostart-toggle'),db:visible('db-path-input'),androidPermission:visible('android-notification-access-btn'),androidBackground:visible('background-keep-running-toggle'),androidApps:visible('android-app-btn')};})()`);
    console.log(JSON.stringify(state));
    await shot('settings');
    assert(state.settings&&state.tray&&state.autostart&&state.db);
    assert(!state.androidPermission&&!state.androidBackground&&!state.androidApps);
    await shot('settings');
    await click('#cancel-settings-btn');
    await click('.ns-welcome .ns-button');await shot('notification-settings');
    await click('.ns-dialog-header .ns-text-button');
    assert.deepEqual(await evaluate(`apiGetSettings()`),before);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({state,embeddedAssetsVerified:true,preferencesPreserved:true,errors},null,2));
    console.log(JSON.stringify({state,embeddedAssetsVerified:true,preferencesPreserved:true,errors}));
  }finally{ws.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
