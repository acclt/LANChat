// Disposable visual regression fixture; never connects to the user's chat database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root = path.resolve(__dirname,'..');
const baseline=process.argv.includes('--baseline');
const output=path.join(root,'artifacts/desktop-ui',baseline?'before':'after');
async function poll(fn) {for(let i=0;i<100;i++){try{const value=await fn();if(value)return value;}catch{}await sleep(100);}throw Error('Timed out');}
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const server=spawn(process.execPath,['tests/notification-preview.cjs'],{cwd:root,windowsHide:true,stdio:'ignore'});
  let browser,ws;
  try{
    await poll(async()=>(await fetch('http://127.0.0.1:18764/')).ok);
    browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=19339',`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(),'lq-desktop-qa-'))}`,'http://127.0.0.1:18764/?desktop-preview=1'],{windowsHide:true,stdio:'ignore'});
    const page=await poll(async()=>(await(await fetch('http://127.0.0.1:19339/json/list')).json()).find(p=>p.url.includes('desktop-preview')));
    ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let id=0;const pending=new Map(),errors=[];
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error||m.result?.exceptionDetails?p.reject(m.error||m.result.exceptionDetails):p.resolve(m.result);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const shot=async name=>{await sleep(150);const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
    const size=(width,height)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const visible=selector=>evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';})()`);
    await send('Runtime.enable');
    await size(1200,820);
    await poll(()=>evaluate(`!!document.querySelector('.ns-welcome')&&!!document.querySelector('#user-list li')`));
    await evaluate(`(()=>{const original=window.__TAURI__.core.invoke;window.desktopQA={calls:[]};window.__TAURI__.core.invoke=async(c,a)=>{desktopQA.calls.push({command:c,args:a});if(c==='get_theme_list')return [{name:'default',display_name:'默认主题',is_custom:false}];if(c==='get_theme_css')return 'body { background: rgb(30,30,40); }';if(c==='get_autostart_enabled')return false;return original(c,a);};})()`);
    await evaluate(`[...document.body.children].find(n=>n.textContent.startsWith('测试：新增通知'))?.remove()`);
    if(!baseline){assert(await visible('.header'));assert(await visible('#settings-btn'));assert(await visible('#theme-btn'));assert(await visible('#add-peer-btn'));}
    await shot('home-1200');
    await click('#settings-btn');
    await poll(()=>evaluate(`!document.getElementById('save-settings-btn').disabled`));
    await shot('settings-1200');
    if(!baseline){
      assert(await visible('#close-to-tray-setting'));
      assert(await visible('#autostart-setting'));
      assert(await visible('#db-path-setting'));
      assert(!await visible('#background-receive-setting'));
      assert(!await visible('#android-notification-access-btn'));
      assert(!await visible('#android-download-location-btn'));
    }
    await click('#cancel-settings-btn');
    await click('#user-list li');
    await sleep(250);
    await evaluate(`addMessageToChat({id:90001,msg_type:'text',content:'这份资料发你了，电脑上查看更方便。',timestamp:1700000000},false);addMessageToChat({id:90002,msg_type:'text',content:'收到了，消息和文件都在这里。',timestamp:1700000060,status:'sent'},true);addMessageToChat({id:90003,msg_type:'text',content:'这是本地测试内容，用来检查多行消息的阅读体验。\\n窗口缩小时，文字会自动换行。',timestamp:1700000120},false);`);
    await shot('chat-1200');
    for(const [width,height] of [[900,700],[760,620],[1440,900],[600,700]]){
      await size(width,height);await sleep(100);
      await shot('chat-'+width);
      if(!baseline){
        assert(await visible('#chat-input'));
        assert.equal(await evaluate('document.documentElement.scrollWidth'),width);
        if(width>=760){
          assert(await visible('.user-list-container'),'Desktop sidebar must remain visible');
          assert(await evaluate(`(()=>{const s=document.querySelector('.user-list-container').getBoundingClientRect(),c=document.getElementById('chat-container').getBoundingClientRect();return s.right<=c.left&&c.top>=document.querySelector('.header').getBoundingClientRect().bottom;})()`),'Chat must not cover the sidebar or toolbar');
        }
        const bounds=await evaluate(`(()=>{const r=document.getElementById('send-btn').getBoundingClientRect();return {right:r.right,bottom:r.bottom};})()`);
        assert(bounds.right<=width&&bounds.bottom<=height);
      }
    }
    await size(1200,820);await click('#close-chat-btn');
    await click('.ns-device');await sleep(200);await shot('notifications-1200');
    await click('.ns-detail-header > button:last-child');await sleep(200);await shot('notification-settings');
    await evaluate(`document.querySelector('.ns-dialog[open]')?.close()`);
    await click('#settings-btn');await sleep(200);await size(760,620);await shot('settings-760');
    if(!baseline){
      const r=await evaluate(`(()=>{const p=document.getElementById('settings-panel').getBoundingClientRect();return {x:p.x,y:p.y,right:p.right,bottom:p.bottom};})()`);
      assert(r.x>=0&&r.y>=0&&r.right<=760&&r.bottom<=620);
    }
    await click('#cancel-settings-btn');await click('#theme-btn');await sleep(250);await shot('appearance');
    await click('#cancel-theme-btn');await click('#add-peer-btn');await sleep(200);await shot('add-device');
    if(!baseline){
      await click('#cancel-peer-btn');
      await evaluate(`(async()=>{await applyTheme('qa-custom');})()`);
      assert(await evaluate(`document.getElementById('desktop-ui-stylesheet').disabled && !!document.getElementById('custom-theme-style')`));
      await evaluate(`applyTheme('default')`);
      assert(await evaluate(`!document.getElementById('desktop-ui-stylesheet').disabled && !document.getElementById('custom-theme-style')`));
      await click('#settings-btn');await poll(()=>evaluate(`!document.getElementById('save-settings-btn').disabled`));
      await evaluate(`document.getElementById('autostart-toggle').checked=true;document.getElementById('auto-download-toggle').checked=false;`);
      await click('#save-settings-btn');
      await poll(()=>evaluate(`document.getElementById('settings-success-msg').classList.contains('show')`));
      assert(await evaluate(`desktopQA.calls.some(c=>c.command==='set_autostart_enabled'&&c.args.enabled===true)`));
      assert(!await evaluate(`desktopQA.calls.some(c=>['set_background_runtime_settings','get_battery_optimization_state','request_storage_permission'].includes(c.command))`));
      await poll(()=>evaluate(`document.getElementById('settings-panel').style.display==='none'`));
      await click('#user-list li');await sleep(250);await click('#select-mode-btn');
      assert(await evaluate(`window.selectMode.active && document.getElementById('chat-input').disabled && document.getElementById('select-mode-btn').classList.contains('active')`));
      await click('#select-mode-btn');
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({baseline,errors,passed:true},null,2));
    console.log(JSON.stringify({output,passed:true}));
  }finally{ws?.close();browser?.kill();server.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
