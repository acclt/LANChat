// Explicit local synthetic verification only. Never opens the user's chat database.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const mode = process.argv[2];
const directory = path.join(require('node:os').tmpdir(), 'lanchat-v4-icons-native-check');
if (mode === 'prepare') {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'lanchat.db'));
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  for (const [key, value] of Object.entries({username:'V4 图标验证',user_id:'v4-icons-local-test',notification_sync_receive:'true',notifications_enabled:'true',port:'19877',download_path:directory})) set.run(key,value);
  db.close();
  console.log(directory);
} else if (mode === 'send' || mode === 'update') {
  const message = {msg_type:'notification',event_id:'v4-icon-'+Date.now(),source_device_id:'v4-test-phone',target_device_id:'v4-icons-local-test',package:'lanchat.test',app_name:'图标合成测试',title:'v4 合成测试通知',text:mode === 'send' ? '验证图标、应用名称、标题和正文。' : '第二次更新：同条通知应被替换。',app_icon:fs.readFileSync(path.join(__dirname,'../src-tauri/icons/32x32.png')).toString('base64'),notification_key:'v4-icons-synthetic',post_time:Date.now()};
  const timer = setTimeout(()=>{console.error('timeout');process.exit(1);},7000);
  let received = false;
  const socket = new WebSocket('ws://127.0.0.1:19877/ws');
  socket.addEventListener('open',()=>socket.send(JSON.stringify(message)));
  socket.addEventListener('message',event=>{
    const reply=JSON.parse(event.data);
    if(reply.msg_type !== 'notification_result') return;
    assert.equal(reply.event_id,message.event_id);
    assert.equal(reply.status,'success');
    received = true; console.log(JSON.stringify(reply)); clearTimeout(timer); socket.close();
  });
  socket.addEventListener('error',error=>{if(received)return;clearTimeout(timer);console.error(error.message);process.exit(1);});
} else { throw new Error('Use prepare, send or update'); }
