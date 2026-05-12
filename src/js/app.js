// src/js/app.js
async function renderPage() {
  console.log("[JS-App] 页面初始化开始...");

  const myName = await apiGetMyName();
  const nameElement = document.getElementById("my-name");
  if (nameElement) {
    nameElement.innerText = myName;
  }

  // 初始化改名功能
  initNameEditor();

  // 初始化设置功能
  initSettings();

  // 初始化主题功能
  initTheme();

  // 初始化聊天功能
  initChat();

  // 使用我们封装好的 apiListen
  await apiListen("new-peer", (event) => {
    addUserToList(
      event.payload.id,
      event.payload.name,
      event.payload.addr,
      false,
    );
  });

  // 监听新消息事件(桌面端)
  await apiListen("new-message", (event) => {
    console.log("[JS-App] ========== 收到 new-message 事件 ==========");
    console.log("[JS-App] 事件类型:", typeof event);
    console.log("[JS-App] 事件对象:", event);
    console.log("[JS-App] payload 类型:", typeof event.payload);
    console.log(
      "[JS-App] payload 内容:",
      JSON.stringify(event.payload, null, 2),
    );
    console.log("[JS-App] ==========================================");
    onReceiveMessage(event.payload);
  });

  // 启动用户列表轮询（桌面端和 Web 端都需要）
  console.log("[JS-App] 启动用户列表轮询");
  startPeerPolling();

  // 启动消息轮询（桌面端和 Web 端都需要，用于检测状态变化）
  const tauri = window.__TAURI__;
  console.log("[JS-App] 启动消息轮询");
  startMessagePolling();

  // Web 端需要额外启动未读消息检查（桌面端通过事件处理）
  if (!tauri) {
    console.log("[JS-App] 启动未读消息检查（Web 端）");
    startUnreadMessageCheck();
  }

  // ==========================================
  // 冷启动分享数据补偿机制
  // ==========================================
  // 留给 Tauri 和后端 1.5 秒的初始化时间，然后主动查一次数据
  setTimeout(async () => {
    // 如果页面已经存在分享弹窗，说明原生广播事件已经正常触发过了，直接跳过，防止重复弹窗！
    if (document.querySelector(".share-dialog")) {
      console.log("[JS-App] 分享弹窗已存在，跳过冷启动补偿检测");
      return;
    }

    try {
      console.log("[JS-App] 执行冷启动分享主动检测...");
      const sharedFiles = await apiGetAndroidSharedFiles();
      if (sharedFiles && sharedFiles.length > 0) {
        console.log(
          "[JS-App] 冷启动主动检测到分享文件，准备弹窗:",
          sharedFiles,
        );
        showShareDialog(sharedFiles);
      }
    } catch (e) {
      console.error("[JS-App] 冷启动检查分享文件失败:", e);
    }
  }, 1500);
}

// Web 端轮询用户列表
async function startPeerPolling() {
  const pollInterval = 1000;

  const updatePeerList = async () => {
    const peers = await apiGetPeers();

    // 获取当前列表中的所有 ID
    const currentIds = new Set();
    const list = document.getElementById("user-list");
    if (list) {
      const items = list.querySelectorAll("li");
      items.forEach((item) => currentIds.add(item.dataset.id));
    }

    // 更新用户列表
    const receivedIds = new Set();
    for (const peer of peers) {
      addUserToList(peer.id, peer.name, peer.addr, peer.is_offline);
      receivedIds.add(peer.id);
    }

    // 移除不在服务器列表中的用户（已经超过60秒）
    for (const id of currentIds) {
      if (!receivedIds.has(id)) {
        removeUserFromList(id);
      }
    }
  };

  // 立即执行一次
  await updatePeerList();

  // 定时轮询
  setInterval(updatePeerList, pollInterval);
}

document.addEventListener("DOMContentLoaded", renderPage);

// 监听 Android 分享事件
window.addEventListener("android-share-received", async () => {
  console.log("[JS-App] ========== 收到 Android 分享事件 ==========");

  try {
    const sharedFiles = await apiGetAndroidSharedFiles();
    console.log("[JS-App] 分享的文件:", sharedFiles);

    if (sharedFiles.length === 0) {
      console.log("[JS-App] 没有待处理的分享文件");
      return;
    }

    console.log("[JS-App] 准备显示分享对话框");
    // 显示在线用户选择弹窗
    showShareDialog(sharedFiles);
  } catch (e) {
    console.error("[JS-App] 处理 Android 分享失败:", e);
  }
});

console.log("[JS-App] Android 分享事件监听器已注册");

// 全局变量保存分享弹窗的定时器
window.shareDialogInterval = null;

// 显示分享对话框
function showShareDialog(sharedFiles) {
  console.log("[JS-App] showShareDialog 被调用，文件数:", sharedFiles.length);

  // 防止重复弹窗，先尝试清理旧的
  closeShareDialog();

  // 创建弹窗 DOM
  const dialog = document.createElement("div");
  dialog.className = "share-dialog";

  // 【关键修复 1】把 onclick 去掉，给按钮加一个专门的 id
  dialog.innerHTML = `
        <div class="share-dialog-content">
            <h3>选择接收者</h3>
            <p>共 ${sharedFiles.length} 个文件</p>
            <ul class="share-user-list" id="share-user-list"></ul>
            <button class="cancel-btn" id="share-cancel-btn">取消</button>
        </div>
    `;

  document.body.appendChild(dialog);
  console.log("[JS-App] 对话框已添加到 DOM");

  // 【关键修复 2】在 DOM 插入页面后，用安全的 JS 方式绑定事件
  const cancelBtn = document.getElementById("share-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeShareDialog);
  }

  // 首次立刻渲染列表
  syncShareUserList(sharedFiles);

  // 开启定时器，每秒无感同步一次主界面的在线用户
  window.shareDialogInterval = setInterval(() => {
    // 如果弹窗已被移除（比如用户点击了取消），自动停止并清理定时器
    if (!document.getElementById("share-user-list")) {
      clearInterval(window.shareDialogInterval);
      window.shareDialogInterval = null;
      return;
    }
    syncShareUserList(sharedFiles);
  }, 1000);
}

// ================= 弹窗内用户列表的增量同步魔法 =================
function syncShareUserList(sharedFiles) {
  const userList = document.getElementById("share-user-list");
  if (!userList) return;

  // 获取主界面上最新的用户列表
  const allUsers = document.querySelectorAll("#user-list li");
  let onlineCount = 0;
  const currentOnlineIds = new Set();

  allUsers.forEach((userItem) => {
    const isOffline = userItem.classList.contains("offline");

    // 只挑选在线的用户
    if (!isOffline) {
      onlineCount++;
      const userId = userItem.dataset.id;
      const userName = userItem.dataset.name;
      const userAddr = userItem.dataset.addr;

      currentOnlineIds.add(userId);

      // 查找弹窗中是否已经渲染过这个用户
      let li = userList.querySelector(`li[data-id="${userId}"]`);
      if (!li) {
        // 如果是新上线的用户，动态创建并插入（不影响其他正在显示的节点）
        li = document.createElement("li");
        li.dataset.id = userId;
        userList.appendChild(li);
      }

      // 实时更新名称和点击事件（防止对方期间改名或 IP 变更）
      li.textContent = userName;
      li.onclick = () =>
        handleShareToUser(userId, userName, userAddr, sharedFiles);
    }
  });

  // 找出已离线或消失的用户并移除
  const currentItems = userList.querySelectorAll("li:not(.no-users)");
  currentItems.forEach((item) => {
    if (!currentOnlineIds.has(item.dataset.id)) {
      item.remove(); // 对方掉线，立刻从弹窗列表中剔除
    }
  });

  // 处理空状态提示（如果没有在线用户）
  const noUsersLi = userList.querySelector(".no-users");
  if (onlineCount === 0) {
    if (!noUsersLi) {
      userList.innerHTML = '<li class="no-users">暂无在线用户</li>';
    }
  } else {
    if (noUsersLi) {
      noUsersLi.remove(); // 有人上线了，移除“暂无用户”的提示
    }
  }
}

// 关闭分享对话框
function closeShareDialog() {
  // 关闭时精准切断定时器，绝不浪费一点手机性能
  if (window.shareDialogInterval) {
    clearInterval(window.shareDialogInterval);
    window.shareDialogInterval = null;
  }

  const dialog = document.querySelector(".share-dialog");
  if (dialog) {
    dialog.remove();
  }
  apiClearAndroidSharedFiles();
}

// 处理分享到指定用户
async function handleShareToUser(userId, userName, userAddr, sharedFiles) {
  console.log("[JS-App] 分享文件到:", userName);

  // 关闭对话框
  closeShareDialog();

  // 打开该用户的聊天界面
  openChat({ id: userId, name: userName, addr: userAddr });

  // 发送所有文件
  for (const fileInfo of sharedFiles) {
    try {
      console.log("[JS-App] 发送文件:", fileInfo.fileName);

      // 发送文件（Rust 会自动创建数据库记录）
      await apiSendFileFromAndroidUri(userId, userAddr, fileInfo);

      console.log("[JS-App] 文件发送成功:", fileInfo.fileName);
    } catch (e) {
      console.error("[JS-App] 文件发送失败:", fileInfo.fileName, e);
      alert(`发送文件失败: ${fileInfo.fileName}\n${e.message}`);
    }
  }

  // 清除待处理的分享文件
  apiClearAndroidSharedFiles();

  // 重新加载聊天历史以显示最新状态
  console.log("[JS-App] 重新加载聊天历史");
  await loadChatHistory(userId);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

document.addEventListener("DOMContentLoaded", renderPage);

// Web 端轮询新消息
// Web 端轮询新消息
// Web 端轮询新消息
async function startMessagePolling() {
  const pollInterval = 1000;

  // 初始化轮询开关
  window.messagePollingEnabled = true;

  const checkNewMessages = async () => {
    // 如果轮询被禁用，或者当前没有聊天对象，直接跳过
    if (!window.messagePollingEnabled || !window.currentChatPeer) {
      return;
    }

    try {
      const chatMessages = document.getElementById("chat-messages");
      const scrollTop = chatMessages.scrollTop;
      const scrollHeight = chatMessages.scrollHeight;
      const clientHeight = chatMessages.clientHeight;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

      // 只获取最新的 20 条消息
      const latestMessages = await apiGetChatHistory(
        window.currentChatPeer.id,
        20,
        0,
      );

      if (!latestMessages || latestMessages.length === 0) return;

      // 通过时间戳判断真正的"新消息"，而不是通过 DOM 节点数量对比
      const newMessages = latestMessages.filter((msg) =>
        msg.timestamp > (window.lastMessageTimestamp || 0)
      );

      // 如果确实有新消息
      if (newMessages.length > 0) {
        // 如果在底部，直接添加消息并滚动
        if (isAtBottom) {
          for (const msg of newMessages) {
            addMessageToChat(msg, msg.from_id === "me");

            // 动态更新最后一条消息的时间戳
            if (msg.timestamp > (window.lastMessageTimestamp || 0)) {
              window.lastMessageTimestamp = msg.timestamp;
            }
          }

          // 维护懒加载的总数量计数器
          if (window.currentChatMessages) {
            window.currentChatMessages.loadedCount += newMessages.length;
            window.currentChatMessages.totalCount += newMessages.length;
          }

          // 滚动到底部
          await scrollToBottom();
        } else {
          // 如果不在底部，只显示红点，不更新时间戳，不添加消息
          // 这样当用户滚动到底部时，轮询会自动检测到这些消息并添加
          console.log("[JS-App] 用户不在底部，显示未读红点（不更新时间戳）");

          const unreadDot = document.getElementById("unread-dot");
          const scrollBtn = document.getElementById("scroll-to-bottom-btn");
          if (unreadDot && scrollBtn) {
            scrollBtn.classList.add("show");
            unreadDot.classList.add("show");
            console.log("[JS-App] 已显示未读红点");
          }
        }
      }
    } catch (e) {
      console.error("[JS-App] 轮询消息失败:", e);
    }
  };

  // 定时轮询
  setInterval(checkNewMessages, pollInterval);
}

// Web 端检查所有用户的未读消息（用于显示左侧列表红点）
async function startUnreadMessageCheck() {
  const pollInterval = 2000; // 2秒检查一次，不需要太频繁

  // 记录每个用户的最后消息时间戳
  if (!window.userLastMessageTimestamps) {
    window.userLastMessageTimestamps = {};
  }

  // 初始化：获取所有用户的当前最新消息时间戳，避免误报
  const initializeTimestamps = async () => {
    try {
      const userList = document.getElementById("user-list");
      if (!userList) return;

      const userItems = userList.querySelectorAll("li");

      for (const userItem of userItems) {
        const userId = userItem.dataset.id;
        if (!userId) continue;

        // 如果还没有记录时间戳，初始化为当前最新消息的时间戳
        if (!window.userLastMessageTimestamps[userId]) {
          const messages = await apiGetChatHistory(userId, 1, 0);
          if (messages && messages.length > 0) {
            window.userLastMessageTimestamps[userId] = messages[0].timestamp;
            console.log(
              "[JS-App] 初始化用户",
              userId,
              "的时间戳:",
              messages[0].timestamp,
            );
          } else {
            // 没有历史消息，设置为当前时间
            window.userLastMessageTimestamps[userId] = Date.now() / 1000;
          }
        }
      }
    } catch (e) {
      console.error("[JS-App] 初始化时间戳失败:", e);
    }
  };

  const checkUnreadMessages = async () => {
    try {
      // 获取所有在线用户
      const userList = document.getElementById("user-list");
      if (!userList) return;

      const userItems = userList.querySelectorAll("li");

      for (const userItem of userItems) {
        const userId = userItem.dataset.id;
        if (!userId) continue;

        // 跳过当前正在聊天的用户（已经在 startMessagePolling 中处理）
        if (window.currentChatPeer && window.currentChatPeer.id === userId) {
          continue;
        }

        // 获取该用户的最新1条消息
        const messages = await apiGetChatHistory(userId, 1, 0);

        if (messages && messages.length > 0) {
          const latestMsg = messages[0];
          const lastTimestamp = window.userLastMessageTimestamps[userId] || 0;

          // 如果有新消息且不是自己发的
          if (
            latestMsg.timestamp > lastTimestamp && latestMsg.from_id !== "me"
          ) {
            console.log("[JS-App] 检测到用户", userId, "有新消息，显示红点");
            userItem.classList.add("has-unread");

            // 把有新消息的用户置顶
            userList.prepend(userItem);

            // 更新时间戳
            window.userLastMessageTimestamps[userId] = latestMsg.timestamp;
          }
        }
      }
    } catch (e) {
      console.error("[JS-App] 检查未读消息失败:", e);
    }
  };

  // 先初始化时间戳
  await initializeTimestamps();

  // 然后开始轮询
  setInterval(checkUnreadMessages, pollInterval);
}
