// Runs only against the disposable, explicitly identified local acceptance instance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(os.tmpdir(), 'lanchat-v4-icons-native-check');
const base = 'http://127.0.0.1:19877';
const source = 'acceptance02-synthetic';
const run = crypto.randomUUID();
const report = { run, started: new Date().toISOString(), files: [], notifications: [] };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function json(url) {
  const result = await fetch(base + url, { signal: AbortSignal.timeout(10000) });
  assert.equal(result.status, 200);
  return result.json();
}
function exchange(message, predicate) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    let settled = false;
    const started = performance.now();
    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve({ reply, elapsed_ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish(Error('WebSocket response timeout')), 7000);
    socket.addEventListener('open', () => socket.send(JSON.stringify(message)));
    socket.addEventListener('error', () => finish(Error('WebSocket error')));
    socket.addEventListener('close', () => { if (!settled) finish(Error('Early close')); });
    socket.addEventListener('message', event => {
      try { const reply = JSON.parse(event.data); if (predicate(reply)) finish(null, reply); }
      catch (error) { finish(error); }
    });
  });
}
async function main() {
  const identity = await json('/api/get_my_id');
  assert.equal(typeof identity === 'string' ? identity : identity.id, 'v4-icons-local-test', 'Refuse to test a non-disposable instance');
  const db = new DatabaseSync(path.join(root, 'lanchat.db'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='download_path'").get().value, root);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='notification_sync_receive'").get().value, 'true');
    const icon = fs.readFileSync(path.join(__dirname, '../src-tauri/icons/32x32.png')).toString('base64');
    const notification = { msg_type: 'notification', source_device_id: source, target_device_id: 'v4-icons-local-test', package: 'lanchat.acceptance', app_name: '验收示例应用', app_icon: icon, title: 'v4 合成测试通知', text: '0.2 本机合成验收', notification_key: run, post_time: Date.now() };
    async function push(extra = {}, expected = 'success') {
      const message = { ...notification, event_id: crypto.randomUUID(), ...extra };
      const result = await exchange(message, reply => reply.msg_type === 'notification_result' && reply.event_id === message.event_id);
      assert.equal(result.reply.status, expected);
      report.notifications.push({ expected, elapsed_ms: result.elapsed_ms });
    }
    const text = '0.2 普通聊天回归 ' + run;
    await exchange({ msg_type: 'text', from_id: source, from_name: '本机验收', content: text, timestamp: Math.floor(Date.now() / 1000) }, reply => reply.content === text);
    assert(db.prepare('SELECT id FROM messages WHERE content=?').get(text));
    report.chat_persisted = true;
    await push();
    await push();
    await push({ text: '第二次更新：同条通知应被替换。' });
    await push({ target_device_id: 'not-this-device' }, 'failure');
    await push({ source_device_id: 'v4-icons-local-test' }, 'failure');
    await push({ app_icon: 'https://example.invalid/never-fetch.png', text: '图标非法时仍应接收文字' });

    let uploadsInFlight = 0;
    async function upload(index, totalBytes) {
      const bytes = Buffer.alloc(totalBytes, 31 + index);
      let name = `acceptance02-${run}-${index}.bin`;
      const chunkSize = 4 * 1024 * 1024;
      const chunks = Math.ceil(bytes.length / chunkSize);
      uploadsInFlight++;
      try {
        for (let part = 0; part < chunks; part++) {
          const form = new FormData();
          for (const [key, value] of Object.entries({peer_id:source,file_name:name,file_size:bytes.length,chunk_index:part,chunk_total:chunks,sender_msg_id:`${run}-${index}`})) form.set(key,String(value));
          form.set('chunk',new Blob([bytes.subarray(part * chunkSize, (part + 1) * chunkSize)]),'chunk.bin');
          const response = await fetch(base + '/api/upload',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
          assert.equal(response.status,200);
          const reply = await response.json();
          assert.equal(reply.status,'success');
          name = reply.file_name;
        }
        const response = await fetch(base + '/api/download/' + encodeURIComponent(name), {signal:AbortSignal.timeout(30000)});
        assert.equal(response.status,200);
        const downloaded = Buffer.from(await response.arrayBuffer());
        assert.equal(hash(downloaded),hash(bytes));
        const saved = db.prepare('SELECT file_path,file_status FROM messages WHERE content=? ORDER BY id DESC LIMIT 1').get(name);
        assert(saved && fs.existsSync(saved.file_path));
        assert.equal(hash(fs.readFileSync(saved.file_path)),hash(bytes));
        report.files.push({bytes:bytes.length,sha256:hash(bytes),status:saved.file_status});
      } finally { uploadsInFlight--; }
    }
    const uploads = Promise.all([upload(1,8*1024*1024),upload(2,16*1024*1024),upload(3,64*1024*1024)]);
    const concurrent = (async()=>{
      for(let i=0;i<6;i++) {
        const active=uploadsInFlight;
        await push({text:`并发文件传输验收 ${i}`});
        report.notifications.at(-1).uploads_in_flight=active;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
    })();
    await Promise.all([uploads,concurrent]);
    report.no_notification_chat_rows = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE msg_type='notification'").get().count === 0;
    assert(report.no_notification_chat_rows);
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(root,'acceptance02-results.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally { db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
