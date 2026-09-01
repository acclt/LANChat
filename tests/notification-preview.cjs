// Local-only UI fixture. Serves the real frontend with a disposable Tauri adapter.
const http = require("http"),
  fs = require("fs"),
  path = require("path");
const root = path.resolve(__dirname, "../src");
const fixtureIcon = fs.readFileSync(path.resolve(__dirname, "../src-tauri/icons/32x32.png")).toString("base64");
const fixture = `(() => {
  const android = new URLSearchParams(location.search).has('android-preview');
  const peers = [{id:'iqoo',name:'IQOO',addr:'192.168.5.10:8888',is_offline:false},{id:'redm',name:'REDM',addr:'192.168.5.11:8888',is_offline:false},{id:'4060',name:'4060',addr:'192.168.5.4:8888',is_offline:true}];
  let settings = {push_enabled:false,receive_enabled:true,allowed_packages:[],target_device_ids:[]};
  const listeners = new Map();
  const records = [{peer_id:'iqoo',peer_name:'IQOO',view_kind:'notification_receive',status:'success',notification:{msg_type:'notification',event_id:'preview-event',source_device_id:'iqoo',target_device_id:'preview-local',package:'example.messages',app_name:'短信',title:'快递到达提醒',text:'您的包裹已到达驿站。此内容是本地界面测试数据，不是真实系统通知。',notification_key:'preview-key',post_time:Date.now()}}];
  records[0].notification.app_icon='${fixtureIcon}';
  records.push({...records[0],notification:{...records[0].notification,event_id:'without-icon',notification_key:'without-icon',app_name:'无图标示例',title:'文字仍然可读',text:'应用图标不可用时显示应用名称首字。',app_icon:null}});
  window.__TAURI__={event:{listen:async(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);return()=>{};}},core:{invoke:async(command,args={})=>{
    switch(command){
      case 'notification_settings':if(args.settings)settings=args.settings;return{settings,platform:android?'android':'windows',access:false,permission:'unknown'};
      case 'notification_records':return records;
      case 'notification_action':return{apps:[{package:'example.messages',name:'短信'},{package:'example.chat',name:'聊天'}]};
      case 'notification_test':if(!settings.push_enabled)throw Error('信息推送未开启');if(!settings.target_device_ids.length)throw Error('请先选择目标设备');return null;
      case 'get_my_name':return android?'我的手机':'我的电脑';case 'get_my_id':return 'preview-local';
      case 'get_peers':return peers;case 'get_local_device_info':return{ip:'192.168.5.20',port:8888};
      case 'get_settings':return{download_path:'D:/Downloads',port:8888,auto_download:true,close_to_tray:true};
      case 'get_language':return 'zh';case 'get_current_theme':return 'default';case 'get_themes':return [];
      case 'get_default_download_path':return 'D:/Downloads';case 'get_notifications_enabled':return true;
      case 'get_unread_count':return 0;case 'get_notification_permission_state':return 'granted';
      case 'get_core_status':return{state:'RUNNING'};
      default:return [];
    }
  }}};
  document.addEventListener('DOMContentLoaded',()=>{
    const toolbar=document.createElement('div');toolbar.style='position:fixed;bottom:0;right:0;z-index:50;background:white;font-size:10px;';
    const add=document.createElement('button');add.textContent='测试：新增通知';add.onclick=()=>{records.unshift({...records[0],notification:{...records[0].notification,event_id:'fixture-'+Date.now(),notification_key:'key-'+Date.now(),title:'新增测试通知',text:'新的示例内容'}});for(const fn of listeners.get('notification-records-changed')||[])fn({payload:null});};
    const update=document.createElement('button');update.textContent='测试：更新通知';update.onclick=()=>{records[records.length-1].notification.text='已更新的测试正文。'+ '用于验证长文本展开和阅读位置。'.repeat(40);for(const fn of listeners.get('notification-records-changed')||[])fn({payload:null});};
    const fail=document.createElement('button');fail.textContent='测试：设置保存失败';fail.onclick=()=>{const original=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(c,a)=>c==='notification_settings'&&a?.settings?Promise.reject('模拟保存失败'):original(c,a);};
    toolbar.append(add,update,fail);document.body.append(toolbar);
  });
})();`;
http
  .createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      return res.end(fixture);
    }
    const file = path.resolve(
      root,
      "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      let bytes = fs.readFileSync(file);
      const ext = path.extname(file);
      res.setHeader(
        "Content-Type",
        ({
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
        }[ext] || "application/octet-stream") + "; charset=utf-8",
      );
      if (ext === ".html")
        bytes = bytes
          .toString()
          .replace(
            '<script src="js/api.js">',
            '<script src="/fixture.js"></script><script src="js/api.js">',
          );
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(18764, "127.0.0.1", () =>
    console.log(
      "Notification UI fixture: http://127.0.0.1:18764/?desktop-preview=1",
    ),
  );
