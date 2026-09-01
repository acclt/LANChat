// Run a supplied QA expression only in the connected LQ Chat Android WebView.
// adb forwarding must point port 19223 at the explicitly selected app process.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  const adb = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
  const serial = '10AFAM1FN5005XG';
  const pid = execFileSync(adb, ['-s', serial, 'shell', 'pidof', 'com.lanchat.app'], { encoding: 'utf8' }).trim();
  assert(/^\d+$/.test(pid), 'Main Android application is not running');
  const forwards = execFileSync(adb, ['forward', '--list'], { encoding: 'utf8' });
  assert(forwards.split(/\r?\n/).some(line => line.trim() === `${serial} tcp:19223 localabstract:webview_devtools_remote_${pid}`),
    'Refuse a WebView forward that does not target the main Android application');
  const expression = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  assert(expression.trim(), 'Missing QA expression');
  const pages = await (await fetch('http://127.0.0.1:19223/json/list', { signal: AbortSignal.timeout(5000) })).json();
  const matches = pages.filter(p => p.url.split('#')[0] === 'http://tauri.localhost/' && p.title === 'LQ Chat');
  assert.equal(matches.length, 1, 'Unexpected Android WebView');
  const ws = new WebSocket(matches[0].webSocketDebuggerUrl);
  const timeout = setTimeout(() => { ws.close(); console.error('Android WebView QA timeout'); process.exitCode = 1; }, 15000);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true } })));
  ws.addEventListener('error', () => { clearTimeout(timeout); process.exitCode = 1; console.error('Android WebView connection error'); });
  ws.addEventListener('message', e => {
    const result = JSON.parse(e.data);
    if (result.id !== 1) return;
    clearTimeout(timeout); ws.close();
    if (result.error || result.result.exceptionDetails) {
      console.error(JSON.stringify(result.error || result.result.exceptionDetails)); process.exitCode = 1;
    } else console.log(JSON.stringify(result.result.result.value, null, 2));
  });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
