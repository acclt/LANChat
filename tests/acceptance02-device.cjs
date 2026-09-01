// Explicit synthetic verification against the user-connected acceptance phone only.
// Never reads existing chat history or changes app settings/permissions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const base = 'http://192.168.5.10:8888';
const expectedId = '9fc7ba0a-1531-4cd6-8b33-8e88421c46b4';
const source = 'acceptance02-pc';
const mode = process.argv[2];
const run = crypto.randomUUID();
const report = { run, mode, started: new Date().toISOString(), connection: 'Wi-Fi LAN', checks: [] };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function exchange(message, matches) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('WebSocket response timeout')), 10000);
    socket.addEventListener('open', () => socket.send(JSON.stringify(message)));
    socket.addEventListener('error', () => finish(Error('WebSocket error')));
    socket.addEventListener('close', () => { if (!settled) finish(Error('Early close')); });
    socket.addEventListener('message', event => {
      try { const reply = JSON.parse(event.data); if (matches(reply)) finish(null, reply); }
      catch (error) { finish(error); }
    });
  });
}
async function main() {
  assert(['transport', 'notification', 'background', 'disabled', 'saf'].includes(mode), 'Choose transport, notification, background, disabled or saf');
  const response = await fetch(base + '/api/get_my_id', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.equal(typeof identity === 'string' ? identity : identity.id, expectedId, 'Refuse an unexpected device');
  if (mode === 'transport' || mode === 'saf') {
    const text = '0.2 真机合成聊天验收 ' + run;
    await exchange({ msg_type: 'text', from_id: source, from_name: '电脑合成验收', content: text, timestamp: Math.floor(Date.now() / 1000) }, r => r.content === text);
    report.checks.push({ check: 'chat_ack', passed: true });
    const sizes = mode === 'saf' ? [1] : [8, 16, 64];
    let transfersInFlight = sizes.length;
    const transfers = Promise.all(sizes.map(async sizeMiB => {
      try {
      const bytes = Buffer.alloc(sizeMiB * 1024 * 1024, sizeMiB);
      const chunkSize = 4 * 1024 * 1024;
      const total = Math.ceil(bytes.length / chunkSize);
      let name = `lanchat-acceptance02-${run}-${sizeMiB}MiB.bin`;
      for (let index = 0; index < total; index++) {
        const form = new FormData();
        for (const [key, value] of Object.entries({ peer_id: source, file_name: name, file_size: bytes.length, chunk_index: index, chunk_total: total, sender_msg_id: `${run}-${sizeMiB}` })) form.set(key, String(value));
        form.set('chunk', new Blob([bytes.subarray(index * chunkSize, (index + 1) * chunkSize)]), 'chunk.bin');
        const response = await fetch(base + '/api/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        assert.equal(response.status, 200);
        const reply = await response.json();
        assert.equal(reply.status, 'success');
        name = reply.file_name;
      }
      const response = await fetch(base + '/api/download/' + encodeURIComponent(name), { signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200);
      const downloaded = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(downloaded), sha256(bytes));
      report.checks.push({ check: 'file_round_trip', file_name: name, size_mib: sizeMiB, sha256: sha256(bytes), passed: true });
      } finally {
        transfersInFlight--;
      }
    }));
    const notifications = (async () => {
      let sequence = 0;
      while (mode === 'transport' && transfersInFlight > 0) {
        const active = transfersInFlight;
        const message = { msg_type: 'notification', event_id: crypto.randomUUID(), source_device_id: source,
          target_device_id: expectedId, package: 'lanchat.acceptance', app_name: '验收示例应用',
          title: '文件并发通知验收', text: `合成通知 ${++sequence}`, notification_key: 'acceptance02-concurrent', post_time: Date.now() };
        const start = performance.now();
        const reply = await exchange(message, r => r.msg_type === 'notification_result' && r.event_id === message.event_id);
        assert.equal(reply.status, 'success');
        report.checks.push({ check: 'notification_during_transfer', transfers_in_flight: active,
          elapsed_ms: Math.round(performance.now() - start), passed: true });
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    })();
    await Promise.all([transfers, notifications]);
  } else {
    const icon = fs.readFileSync(path.join(__dirname, '../src-tauri/icons/32x32.png')).toString('base64');
    const payload = { msg_type: 'notification', source_device_id: source, target_device_id: expectedId, package: 'lanchat.acceptance', app_name: '验收示例应用', app_icon: icon, title: '0.2 真机合成通知', text: '应用图标、应用名称和通知正文。', notification_key: 'acceptance02-device-display', post_time: Date.now() };
    async function push(extra, expected) {
      const message = { ...payload, ...extra, event_id: crypto.randomUUID() };
      const start = performance.now();
      const reply = await exchange(message, r => r.msg_type === 'notification_result' && r.event_id === message.event_id);
      assert.equal(reply.status, expected);
      report.checks.push({ check: 'notification', expected, elapsed_ms: Math.round(performance.now() - start), passed: true });
    }
    if (mode === 'disabled') {
      await push({ title: '接收关闭验收', text: '这条合成通知不应发布' }, 'failure');
    } else if (mode === 'background') {
      await push({ text: '后台／息屏合成验收 ' + run }, 'success');
    } else {
      await push({}, 'success');
      await push({}, 'success');
      await push({ text: '第二次更新：同条通知应保留图标和应用名，只更新正文。' }, 'success');
      await push({ target_device_id: 'wrong-target' }, 'failure');
      await push({ source_device_id: expectedId }, 'failure');
    }
  }
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, `../artifacts/0.2/device/${mode}-${run}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
