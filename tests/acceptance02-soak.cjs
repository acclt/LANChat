// Two-hour synthetic mixed-load check against the disposable Windows instance only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = 'http://127.0.0.1:19877';
const pid = Number(process.argv[2]);
assert(Number.isSafeInteger(pid) && pid > 0);
const out = path.join(__dirname, '../artifacts/0.2/device/windows-two-hour-soak.json');
const run = crypto.randomUUID();
const started = Date.now();
const report = { run, started: new Date(started).toISOString(), required_ms: 7200000, pid,
  scope: 'Windows disposable DB; local loopback, not Android or Wi-Fi', iterations: 0,
  notifications: 0, files: 0, samples: [], failures: [], state: 'running' };
const save = () => fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function exchange(message, match) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    let done = false;
    const end = error => {
      if (done) return;
      done = true; clearTimeout(timer); ws.close();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => end(Error('WS timeout')), 10000);
    ws.addEventListener('open', () => ws.send(JSON.stringify(message)));
    ws.addEventListener('error', () => end(Error('WS error')));
    ws.addEventListener('close', () => { if (!done) end(Error('WS early close')); });
    ws.addEventListener('message', event => {
      try { if (match(JSON.parse(event.data))) end(); } catch (e) { end(e); }
    });
  });
}
async function main() {
  const identity = await (await fetch(base + '/api/get_my_id')).json();
  assert.equal(typeof identity === 'string' ? identity : identity.id, 'v4-icons-local-test');
  save();
  while (Date.now() - started < report.required_ms) {
    const iteration = report.iterations;
    const title = '0.2 长稳合成通知';
    const content = `acceptance02-soak-${run}-${iteration}`;
    const message = { msg_type: 'notification', event_id: crypto.randomUUID(), source_device_id: 'acceptance02-soak',
      target_device_id: 'v4-icons-local-test', package: 'lanchat.acceptance', app_name: '长稳验收', title,
      text: content, notification_key: 'acceptance02-soak', post_time: Date.now() };
    const notificationStart = performance.now();
    await Promise.all([
      exchange({ msg_type: 'text', from_id: 'acceptance02-soak', from_name: '长稳验收', content,
        timestamp: Math.floor(Date.now() / 1000) }, r => r.content === content),
      exchange(message, r => {
        if (r.msg_type !== 'notification_result' || r.event_id !== message.event_id) return false;
        assert.equal(r.status, 'success'); return true;
      }),
      (async () => {
        const bytes = Buffer.alloc(1024 * 1024, iteration % 256);
        const form = new FormData();
        for (const [k, v] of Object.entries({ peer_id: 'acceptance02-soak', file_name: content + '.bin',
          file_size: bytes.length, chunk_index: 0, chunk_total: 1, sender_msg_id: content })) form.set(k, String(v));
        form.set('chunk', new Blob([bytes]), 'chunk.bin');
        const uploaded = await fetch(base + '/api/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
        assert.equal(uploaded.status, 200);
        const reply = await uploaded.json(); assert.equal(reply.status, 'success');
        const download = await fetch(base + '/api/download/' + encodeURIComponent(reply.file_name), { signal: AbortSignal.timeout(30000) });
        assert.equal(download.status, 200);
        const hash = data => crypto.createHash('sha256').update(data).digest('hex');
        assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(bytes));
        report.files++;
      })()
    ]);
    report.notifications++;
    if (iteration % 2 === 0) {
      const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; if ($p.Path -ne 'D:\\SoftwareFree\\LANChat-android-file-actions\\artifacts\\0.2\\LQ-Chat-0.2-windows.exe') { throw 'Unexpected process' }; [pscustomobject]@{working_set=$p.WorkingSet64;private_bytes=$p.PrivateMemorySize64;handles=$p.HandleCount;cpu_seconds=$p.TotalProcessorTime.TotalSeconds}|ConvertTo-Json -Compress`;
      const sample = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }));
      report.samples.push({ elapsed_ms: Date.now() - started, batch_ms: Math.round(performance.now() - notificationStart), ...sample });
    }
    report.iterations++;
    report.elapsed_ms = Date.now() - started;
    save();
    await pause(Math.min(30000, Math.max(0, report.required_ms - report.elapsed_ms)));
  }
  report.elapsed_ms = Date.now() - started;
  report.finished = new Date().toISOString(); report.state = 'completed'; save();
  console.log(JSON.stringify({ state: report.state, elapsed_ms: report.elapsed_ms, files: report.files, notifications: report.notifications }));
}
main().catch(e => { report.state = 'failed'; report.failures.push(String(e)); save(); console.error(e); process.exitCode = 1; });
