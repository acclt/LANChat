// 图标 SVG 常量
const ICON_SELECT_LIST =
  `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
const ICON_CANCEL_X =
  `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

// 初始化改名功能
function initNameEditor() {
  const editBtn = document.getElementById("edit-name-btn");
  const editPanel = document.getElementById("edit-name-panel");
  const nameInput = document.getElementById("new-name-input");
  const saveBtn = document.getElementById("save-name-btn");
  const cancelBtn = document.getElementById("cancel-name-btn");
  const errorMsg = document.getElementById("error-msg");
  const nameDisplay = document.getElementById("my-name");

  // 点击编辑按钮 - 切换显示/隐藏
  editBtn.addEventListener("click", () => {
    if (editPanel.style.display === "block") {
      // 当前是显示状态,点击后隐藏
      editPanel.style.display = "none";
      errorMsg.textContent = "";
    } else {
      // 当前是隐藏状态,点击后显示
      editPanel.style.display = "block";
      nameInput.value = "";
      nameInput.focus();
      errorMsg.textContent = "";
    }
  });

  // 点击取消按钮
  cancelBtn.addEventListener("click", () => {
    editPanel.style.display = "none";
    errorMsg.textContent = "";
  });

  // 点击保存按钮
  saveBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim();

    if (!newName) {
      errorMsg.textContent = "用户名不能为空";
      return;
    }

    if (newName.length > 50) {
      errorMsg.textContent = "用户名过长(最多50个字符)";
      return;
    }

    try {
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中...";
      errorMsg.textContent = "";

      const updatedName = await apiUpdateMyName(newName);

      // 更新显示
      nameDisplay.textContent = updatedName;
      editPanel.style.display = "none";

      console.log("[UI] 用户名更新成功:", updatedName);
    } catch (e) {
      errorMsg.textContent = e.message || "更新失败";
      console.error("[UI] 更新用户名失败:", e);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  });

  // 支持回车键保存
  nameInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      saveBtn.click();
    }
  });

  // 支持 ESC 键取消
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cancelBtn.click();
    }
  });
}

// 添加新用户到列表
async function addUserToList(id, name, addr, isOffline = false) {
  const list = document.getElementById("user-list");
  if (!list) return;

  // 检查是否已存在
  const existingItems = list.querySelectorAll("li");
  for (let item of existingItems) {
    if (item.dataset.id === id) {
      // 已存在,更新状态
      updateUserStatus(item, name, addr, isOffline);
      return;
    }
  }

  // 不存在,创建新的
  const li = document.createElement("li");
  li.dataset.id = id;
  li.dataset.name = name;
  li.dataset.addr = addr;
  li.innerHTML = `
        <span class="user-name">${name}</span>
        <span class="user-addr">${addr}</span>
        <span class="user-status">${isOffline ? "offline" : ""}</span>
    `;

  if (isOffline) {
    li.classList.add("offline");
  }

  // 添加点击事件,从 dataset 动态读取最新数据,而不是使用闭包里的旧变量
  li.addEventListener("click", function (e) {
    const targetLi = e.currentTarget;
    openChat({
      id: targetLi.dataset.id,
      name: targetLi.dataset.name,
      addr: targetLi.dataset.addr,
    });
  });

  // 桌面端右键
  li.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    const targetLi = e.currentTarget;
    showUserActionDialog(targetLi.dataset.id, targetLi.dataset.name);
  });

  // 移动端长按逻辑
  let touchTimer;
  li.addEventListener("touchstart", function (e) {
    const targetLi = e.currentTarget;
    touchTimer = setTimeout(() => {
      showUserActionDialog(targetLi.dataset.id, targetLi.dataset.name);
    }, 600); // 600ms 定义为长按
  });
  li.addEventListener("touchend", () => clearTimeout(touchTimer));
  li.addEventListener("touchmove", () => clearTimeout(touchTimer));

  list.appendChild(li);
  sortUserList();

  // 初始化新用户的时间戳,避免误报未读消息
  if (!window.userLastMessageTimestamps) {
    window.userLastMessageTimestamps = {};
  }

  if (!window.userLastMessageTimestamps[id]) {
    try {
      const messages = await apiGetChatHistory(id, 1, 0);
      if (messages && messages.length > 0) {
        window.userLastMessageTimestamps[id] = messages[0].timestamp;
        console.log(
          "[UI] 初始化新用户",
          name,
          "的时间戳:",
          messages[0].timestamp,
        );
      } else {
        // 没有历史消息,设置为当前时间
        window.userLastMessageTimestamps[id] = Date.now() / 1000;
        console.log("[UI] 新用户", name, "没有历史消息,设置时间戳为当前时间");
      }
    } catch (e) {
      console.warn("[UI] 初始化用户时间戳失败:", e);
      // 失败时也设置为当前时间,避免误报
      window.userLastMessageTimestamps[id] = Date.now() / 1000;
    }
  }

  console.log(
    "[UI] 添加用户到列表:",
    name,
    id,
    isOffline ? "(离线)" : "(在线)",
  );
}

// 更新用户状态
function updateUserStatus(item, name, addr, isOffline) {
  const statusSpan = item.querySelector(".user-status");
  const nameSpan = item.querySelector(".user-name");
  const addrSpan = item.querySelector(".user-addr");

  if (nameSpan) nameSpan.textContent = name;
  if (addrSpan) addrSpan.textContent = addr;
  if (statusSpan) statusSpan.textContent = isOffline ? "OFF" : "";

  // 实时更新 DOM 的隐式数据属性
  item.dataset.name = name;
  item.dataset.addr = addr;

  const wasOffline = item.classList.contains("offline");

  if (isOffline) {
    item.classList.add("offline");
  } else {
    item.classList.remove("offline");
  }

  // 只要状态发生了变化(上线或下线),就重排一次列表
  if (wasOffline !== isOffline) {
    console.log(`[UI] 用户 ${name} 状态变更为: ${isOffline ? "离线" : "在线"}`);
    sortUserList();
  }
}

// 通用排序函数:未读 > 在线 > 字母顺序
function sortUserList() {
  const list = document.getElementById("user-list");
  if (!list) return;

  const items = Array.from(list.querySelectorAll("li"));

  items.sort((a, b) => {
    // 1. 检查未读状态 (最高优先级)
    const aUnread = a.classList.contains("has-unread") ? 1 : 0;
    const bUnread = b.classList.contains("has-unread") ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;

    // 2. 检查离线状态 (在线 > 离线)
    const aOffline = a.classList.contains("offline") ? 1 : 0;
    const bOffline = b.classList.contains("offline") ? 1 : 0;
    if (aOffline !== bOffline) return aOffline - bOffline;

    // 3. 按名称排序 (稳定性排序)
    const aName = a.querySelector(".user-name").textContent.toLowerCase();
    const bName = b.querySelector(".user-name").textContent.toLowerCase();
    return aName.localeCompare(bName);
  });

  // 重新按顺序添加进 DOM
  items.forEach((item) => list.appendChild(item));
}

// 当前聊天对象 - 全局变量
window.currentChatPeer = null;

// 初始化聊天功能
function initChat() {
  const closeChatBtn = document.getElementById("close-chat-btn");
  const sendBtn = document.getElementById("send-btn");
  const chatInput = document.getElementById("chat-input");
  const attachFileBtn = document.getElementById("attach-file-btn");
  const fileInput = document.getElementById("file-input");
  const chatContainer = document.getElementById("chat-container");

  // 关闭聊天窗口
  closeChatBtn.addEventListener("click", () => {
    // 如果在多选模式,先退出
    if (window.selectMode && window.selectMode.active) {
      exitSelectMode();
    }
    closeChat();
  });

  // 发送消息 - 统一处理发送和删除
  sendBtn.addEventListener("click", () => {
    if (window.selectMode && window.selectMode.active) {
      deleteSelectedMessages();
    } else {
      sendMessage();
    }
  });

  // 自动调整 textarea 高度
  function adjustTextareaHeight() {
    chatInput.style.height = "auto";
    const newHeight = Math.min(chatInput.scrollHeight, 200);
    chatInput.style.height = newHeight + "px";
  }

  // 输入时调整高度
  chatInput.addEventListener("input", adjustTextareaHeight);

  // 回车发送(Shift+Enter 换行)
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 选择文件
  attachFileBtn.addEventListener("click", () => {
    const tauri = window.__TAURI__;
    if (tauri) {
      // 桌面端 - 直接调用 sendFile,它会弹出对话框
      sendFile(null);
    } else {
      // Web 端 - 触发文件选择
      fileInput.click();
    }
  });

  // 文件选择后发送(仅 Web 端)
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) {
      await sendFile(file);
      fileInput.value = ""; // 清空选择
    }
  });

  // 拖拽文件功能
  initDragAndDrop(chatContainer);

  // 粘贴文件功能
  initPasteFile();

  // 初始化多选模式
  initSelectMode();

  // 初始化回到底部按钮
  initScrollToBottomBtn();
}

// 打开聊天
function openChat(peer) {
  const chatContainer = document.getElementById("chat-container");
  if (!chatContainer) return;

  // 1. 检查是否已经是当前聊天的用户且窗口已开
  if (
    window.currentChatPeer && window.currentChatPeer.id === peer.id &&
    chatContainer.style.display === "flex"
  ) {
    return;
  }

  // 2. 手机端 Hash 处理
  if (window.innerWidth <= 768) {
    if (window.location.hash !== "#chat") {
      window.history.pushState({ chatOpen: true }, "", "#chat");
    }
  }

  window.currentChatPeer = peer;

  // 3. 立即显示界面(提升响应感)
  chatContainer.style.display = "flex";

  const chatWithName = document.getElementById("chat-with-name");
  const chatMessages = document.getElementById("chat-messages");

  if (chatWithName) chatWithName.textContent = `${peer.name}`;
  if (chatMessages) chatMessages.innerHTML = ""; // 加载前清空

  // 4. 消除红点和高亮
  const userLi = document.querySelector(`#user-list li[data-id="${peer.id}"]`);
  if (userLi) {
    userLi.classList.remove("has-unread");
  }
  updateListHighlight(peer.id);

  // 5. 异步加载历史
  window.lastMessageTimestamp = 0;
  loadChatHistory(peer.id).catch((e) => {
    console.error("[UI] 加载历史失败:", e);
  });

  console.log("[UI] 成功进入聊天:", peer.name);
}

// 2. 关闭聊天(由 X 按钮或物理返回键调用)
function closeChat() {
  // 如果是手机端且有 #chat,点击 X 按钮时触发 back() 即可,剩下的交给 popstate
  if (window.innerWidth <= 768 && window.location.hash === "#chat") {
    window.history.back();
    return;
  }
  performCloseChatUI();
}

// 3. 真正的 UI 隐藏逻辑(只管藏,不管历史记录)
function performCloseChatUI() {
  // 如果在多选模式,先退出
  if (window.selectMode && window.selectMode.active) {
    exitSelectMode();
  }

  const chatContainer = document.getElementById("chat-container");
  if (chatContainer) chatContainer.style.display = "none";
  window.currentChatPeer = null;
  updateListHighlight(null); // 清除高亮
}

// 4. 辅助函数:更新高亮
function updateListHighlight(activeId) {
  const items = document.querySelectorAll("#user-list li");
  items.forEach((item) => {
    if (activeId && item.dataset.id === activeId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// 5. 全局监听器:处理物理返回键和手动后退
window.addEventListener("popstate", function (event) {
  const chatContainer = document.getElementById("chat-container");

  // 【场景 A】如果当前处于多选模式
  if (window.selectMode && window.selectMode.active) {
    console.log("[UI] 拦截返回键:退出多选模式");

    // 手动执行退出多选的 UI 恢复逻辑
    window.selectMode.active = false;
    window.selectMode.selectedMessages.clear();

    const selectModeBtn = document.getElementById("select-mode-btn");
    const sendBtn = document.getElementById("send-btn");
    const chatInput = document.getElementById("chat-input");
    const attachFileBtn = document.getElementById("attach-file-btn");

    // 恢复图标
    if (selectModeBtn) {
      selectModeBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
      selectModeBtn.classList.remove("active");
    }

    if (sendBtn) {
      sendBtn.textContent = "发送";
      sendBtn.style.backgroundColor = "";
      sendBtn.style.borderColor = "";
      sendBtn.style.color = "";
    }

    if (chatInput) chatInput.disabled = false;
    if (attachFileBtn) attachFileBtn.disabled = false;

    const messages = document.querySelectorAll(".message");
    messages.forEach((msg) => {
      // 简单清理
      const checkbox = msg.querySelector(".select-checkbox");
      if (checkbox) checkbox.remove();
      msg.classList.remove("selectable", "selected");
    });

    const fileContainers = document.querySelectorAll(".message-file");
    fileContainers.forEach((container) =>
      container.style.pointerEvents = "auto"
    );

    // 【核心修复 1】平板/手机 URL 状态修正
    // 如果是手机端,且当前不是 #chat,补回 #chat 以保持聊天窗口打开
    if (window.innerWidth <= 768 && window.location.hash !== "#chat") {
      window.history.replaceState({ chatOpen: true }, "", "#chat");
    }

    return;
  }

  // 【场景 B】正常关闭聊天窗口逻辑
  // 如果 URL 已经不是 #chat 了
  if (window.location.hash !== "#chat") {
    if (window.innerWidth <= 768) {
      performCloseChatUI();
    }
  }
});

// 发送消息
async function sendMessage() {
  if (!window.currentChatPeer) return;

  const chatInput = document.getElementById("chat-input");
  const content = chatInput.value.trim();
  if (!content) return;

  chatInput.value = "";
  chatInput.style.height = "auto";

  try {
    // 1. 发送 API
    await apiSendMessage(
      window.currentChatPeer.id,
      window.currentChatPeer.addr,
      content,
    );

    // 2. 发送完后,纯粹地通过刷新历史记录让它显示出来
    await loadChatHistory(window.currentChatPeer.id, true);
    await scrollToBottom();
  } catch (e) {
    console.error("[UI] 发送异常:", e);
    alert("发送失败: " + e.message);
  }
}

function addMessageToChat(message, isSent) {
  // 如果 ID 依然是无效的，坚决不渲染到 DOM，防止产生无法选中的"僵尸"气泡
  if (!message.id || message.id === "null") return;
  const chatMessages = document.getElementById("chat-messages");
  const existing = chatMessages.querySelector(`[data-msg-id="${message.id}"]`);
  if (existing) {
    // 替换而非先删后加，避免并发时多条路径同时检测不到已有元素
    existing.replaceWith(createMessageElement(message, isSent));
  } else {
    chatMessages.appendChild(createMessageElement(message, isSent));
  }

  if (message.timestamp && !String(message.id).startsWith("temp_")) {
    if (message.timestamp > (window.lastMessageTimestamp || 0)) {
      window.lastMessageTimestamp = message.timestamp;
    }
  }
}

// 在聊天顶部插入消息（带防重检查）
function prependMessageToChat(message, isSent) {
  if (!message.id || message.id === "null") return;
  const chatMessages = document.getElementById("chat-messages");
  const existing = chatMessages.querySelector(`[data-msg-id="${message.id}"]`);
  if (existing) {
    existing.replaceWith(createMessageElement(message, isSent));
  } else {
    chatMessages.insertBefore(createMessageElement(message, isSent), chatMessages.firstChild);
  }
}

// 更新流式消息气泡内容
function updateStreamMessage(message) {
  if (!message.stream_id) return;
  const chatMessages = document.getElementById("chat-messages");
  const existing = chatMessages.querySelector(`[data-stream-id="${message.stream_id}"]`);

  if (existing) {
    const textSpan = existing.querySelector(".message-text");
    if (textSpan) {
      textSpan.textContent = message.content;
    }
  } else {
    const messageDiv = createMessageElement(message, false);
    messageDiv.dataset.streamId = message.stream_id;
    chatMessages.appendChild(messageDiv);
  }
}

// 创建文件图标元素
function createFileIcon(message) {
  const fileInfo = document.createElement("div");
  fileInfo.className = "file-info-wrapper";

  // 1. 图标
  const fileIcon = document.createElement("span");
  fileIcon.className = "file-icon";
  fileIcon.textContent = "📄";

  // 2. 文件信息
  const fileInfoText = document.createElement("div");
  fileInfoText.className = "file-info";

  // 文件名
  const fileName = document.createElement("div");
  fileName.className = "file-name";
  fileName.textContent = message.file_name || message.content;

  // 文件大小
  const fileSize = document.createElement("div");
  fileSize.className = "file-size";
  fileSize.textContent = message.file_size
    ? formatFileSize(message.file_size)
    : "未知大小";

  fileInfoText.appendChild(fileName);
  fileInfoText.appendChild(fileSize);

  fileInfo.appendChild(fileIcon);
  fileInfo.appendChild(fileInfoText);

  return fileInfo;
}

// 检查是否是图片文件
function isImageFile(fileName) {
  if (!fileName) return false;

  const imageExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".webp",
    ".svg",
    ".ico",
  ];
  const lowerFileName = fileName.toLowerCase();

  return imageExtensions.some((ext) => lowerFileName.endsWith(ext));
}

// 等待聊天窗口中的所有图片加载完成
function waitForImagesToLoad(container) {
  return new Promise((resolve) => {
    const images = container.querySelectorAll("img");

    if (images.length === 0) {
      resolve();
      return;
    }

    let loadedCount = 0;
    const totalImages = images.length;

    const checkAllLoaded = () => {
      loadedCount++;
      if (loadedCount === totalImages) {
        resolve();
      }
    };

    images.forEach((img) => {
      if (img.complete) {
        checkAllLoaded();
      } else {
        img.addEventListener("load", checkAllLoaded);
        img.addEventListener("error", checkAllLoaded); // 即使加载失败也要继续
      }
    });

    // 设置超时,避免永久等待
    setTimeout(() => {
      resolve();
    }, 2000);
  });
}

// 滚动到聊天窗口底部(等待图片加载)
async function scrollToBottom() {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;

  // 等待图片加载完成
  await waitForImagesToLoad(chatMessages);

  // 滚动到底部
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 加载聊天历史(支持懒加载)
async function loadChatHistory(peerId, preserveScroll = false) {
  try {
    // 禁用轮询,避免干扰加载过程
    const wasPollingEnabled = window.messagePollingEnabled;
    window.messagePollingEnabled = false;

    // 首次加载,获取最新的10条消息
    const messages = await apiGetChatHistory(peerId, 10, 0);

    const chatMessages = document.getElementById("chat-messages");

    // 保存当前滚动位置
    const oldScrollTop = chatMessages.scrollTop;
    const oldScrollHeight = chatMessages.scrollHeight;
    const wasAtBottom =
      oldScrollHeight - oldScrollTop - chatMessages.clientHeight < 100;

    chatMessages.innerHTML = "";

    // 存储当前对话的消息总数和已加载数量
    window.currentChatMessages = {
      peerId: peerId,
      loadedCount: messages.length,
      totalCount: messages.length,
      isLoading: false,
      hasMore: true, // 默认假设有更多,尝试加载时才知道
    };

    for (const msg of messages) {
      addMessageToChat(msg, msg.from_id === "me");
      // 更新最后消息时间戳
      if (msg.timestamp > (window.lastMessageTimestamp || 0)) {
        window.lastMessageTimestamp = msg.timestamp;
      }
    }

    // 等待图片加载完成
    await waitForImagesToLoad(chatMessages);

    // 首次加载时,如果没有滚动条,继续加载更多消息直到出现滚动条或没有更多消息
    if (!preserveScroll) {
      let hasScrollbar = chatMessages.scrollHeight > chatMessages.clientHeight;

      while (!hasScrollbar && window.currentChatMessages.hasMore) {
        const offset = window.currentChatMessages.loadedCount;
        const moreMessages = await apiGetChatHistory(peerId, 10, offset);

        if (moreMessages.length === 0) {
          window.currentChatMessages.hasMore = false;
          break;
        }

        // 在顶部插入消息
        for (let i = moreMessages.length - 1; i >= 0; i--) {
          const msg = moreMessages[i];
          prependMessageToChat(msg, msg.from_id === "me");
        }

        window.currentChatMessages.loadedCount += moreMessages.length;

        if (moreMessages.length < 10) {
          window.currentChatMessages.hasMore = false;
          break;
        }

        // 等待图片加载
        await waitForImagesToLoad(chatMessages);

        // 检查是否出现滚动条
        hasScrollbar = chatMessages.scrollHeight > chatMessages.clientHeight;
      }

      // 自动加载完成后,滚动到底部
      await scrollToBottom();
    } else {
      // 恢复滚动位置
      if (!wasAtBottom) {
        // 如果用户不在底部,尝试保持相对位置
        const newScrollHeight = chatMessages.scrollHeight;
        const scrollDiff = newScrollHeight - oldScrollHeight;
        chatMessages.scrollTop = oldScrollTop + scrollDiff;
      } else {
        // 用户在底部时,滚动到底部
        await scrollToBottom();
      }
    }

    // 只在首次加载时初始化滚动监听器
    if (!preserveScroll && !window.scrollListenerAttached) {
      initScrollListener();
    }

    // 恢复轮询
    window.messagePollingEnabled = wasPollingEnabled;
  } catch (e) {
    console.error("[UI] 加载历史消息失败:", e);
    // 出错时也要恢复轮询
    window.messagePollingEnabled = true;
  }
}

// 初始化滚动监听器(懒加载)
function initScrollListener() {
  const chatMessages = document.getElementById("chat-messages");

  // 移除旧的监听器(如果存在)
  if (window.scrollListenerAttached) {
    chatMessages.removeEventListener("scroll", window.handleChatScroll);
  }

  // 定义滚动处理函数
  window.handleChatScroll = async function () {
    if (!window.currentChatMessages) {
      return;
    }

    if (window.currentChatMessages.isLoading) {
      return;
    }

    const scrollTop = chatMessages.scrollTop;
    const scrollHeight = chatMessages.scrollHeight;
    const clientHeight = chatMessages.clientHeight;

    // 检查是否滚动到底部(距离底部小于100px)
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

    // 如果滚动到底部,触发一次刷新(检查新消息)
    if (isAtBottom && window.lastScrollWasNotAtBottom) {
      console.log("[UI] 滚动到底部,检查新消息");
      window.currentChatMessages.isLoading = true;
      try {
        // 同样只取最新的小批量,靠时间戳过滤
        const latestMessages = await apiGetChatHistory(
          window.currentChatMessages.peerId,
          20,
          0,
        );
        const newMessages = latestMessages.filter((msg) =>
          msg.timestamp > (window.lastMessageTimestamp || 0)
        );

        if (newMessages.length > 0) {
          for (const msg of newMessages) {
            addMessageToChat(msg, msg.from_id === "me");
            if (msg.timestamp > (window.lastMessageTimestamp || 0)) {
              window.lastMessageTimestamp = msg.timestamp;
            }
          }
          window.currentChatMessages.loadedCount += newMessages.length;
          window.currentChatMessages.totalCount += newMessages.length;
          await scrollToBottom();
        }
      } catch (e) {
        console.error("[UI] 检查新消息失败:", e);
      } finally {
        window.currentChatMessages.isLoading = false;
      }
    }

    // 记录当前是否在底部
    window.lastScrollWasNotAtBottom = !isAtBottom;

    if (!window.currentChatMessages.hasMore) {
      return;
    }

    // 检查是否滚动到顶部(距离顶部小于100px)
    // 同时确保不是刚加载完(scrollHeight > clientHeight 说明有滚动条)
    const hasScrollbar = scrollHeight > clientHeight;
    if (hasScrollbar && scrollTop < 100) {
      console.log("[UI] 触发懒加载,加载更多历史消息");

      window.currentChatMessages.isLoading = true;

      // 暂时禁用消息轮询,防止干扰
      const wasPollingEnabled = window.messagePollingEnabled;
      window.messagePollingEnabled = false;

      try {
        // 加载更多消息
        const offset = window.currentChatMessages.loadedCount;

        const moreMessages = await apiGetChatHistory(
          window.currentChatMessages.peerId,
          10,
          offset,
        );

        if (moreMessages.length === 0) {
          console.log("[UI] 没有更多历史消息了");
          window.currentChatMessages.hasMore = false;
          window.currentChatMessages.isLoading = false;
          window.messagePollingEnabled = wasPollingEnabled;
          return;
        }

        // 保存当前滚动位置
        const oldScrollTop = chatMessages.scrollTop;
        const oldScrollHeight = chatMessages.scrollHeight;

        // 在顶部插入消息(倒序插入)
        for (let i = moreMessages.length - 1; i >= 0; i--) {
          const msg = moreMessages[i];
          prependMessageToChat(msg, msg.from_id === "me");
        }

        // 更新已加载数量
        window.currentChatMessages.loadedCount += moreMessages.length;

        // 如果返回的消息少于10条,说明没有更多了
        if (moreMessages.length < 10) {
          window.currentChatMessages.hasMore = false;
        }

        // 恢复滚动位置(保持在原来的消息位置)
        // 使用 requestAnimationFrame 确保 DOM 更新完成后再设置滚动位置
        requestAnimationFrame(() => {
          const newScrollHeight = chatMessages.scrollHeight;
          const addedHeight = newScrollHeight - oldScrollHeight;
          const newScrollTop = oldScrollTop + addedHeight;

          chatMessages.scrollTop = newScrollTop;

          // 恢复消息轮询
          setTimeout(() => {
            window.messagePollingEnabled = wasPollingEnabled;
          }, 100);
        });
      } catch (e) {
        console.error("[UI] 加载更多消息失败:", e);
        window.messagePollingEnabled = wasPollingEnabled;
      } finally {
        window.currentChatMessages.isLoading = false;
      }
    }
  };

  // 添加滚动监听器
  chatMessages.addEventListener("scroll", window.handleChatScroll);
  window.scrollListenerAttached = true;
}

// 创建消息元素
function createMessageElement(message, isSent) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isSent ? "sent" : "received"}`;
  // 严谨地检查 ID 是否存在,防止绑定 "undefined"
  if (message.id !== undefined && message.id !== null) {
    messageDiv.dataset.msgId = message.id;
  }

  // 把当前状态存入数据集,方便轮询检测
  messageDiv.dataset.status = message.status || "sent";

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  // ---- 构建消息主体 ----
  if (message.msg_type === "file") {
    const fileContainer = document.createElement("div");
    fileContainer.className = "message-file";

    const isImage = isImageFile(message.file_name || message.content);
    if (
      isImage && message.file_path &&
      (message.file_status === "sent" || message.file_status === "accepted")
    ) {
      const imgPreview = document.createElement("div");
      imgPreview.className = "image-preview";
      const img = document.createElement("img");

      const tauri = window.__TAURI__;
      if (tauri) {
        const isAndroid = navigator.userAgent.includes("Android");
        if (
          isAndroid && message.file_path &&
          message.file_path.startsWith("content://")
        ) {
          apiGetMediaToken().then((token) => {
            img.src = `http://127.0.0.1:8888/api/media?uri=${
              encodeURIComponent(message.file_path)
            }&token=${token}`;
          });
        } else {
          img.src = tauri.core.convertFileSrc(message.file_path);
        }
      } else if (message.file_id) {
        img.src = `/api/download/${message.file_id}`;
      }

      img.alt = message.file_name || message.content;
      img.loading = "lazy";
      img.onerror = () => {
        console.error(
          "[Image] 加载失败:",
          img.src,
          "file_path:",
          message.file_path,
          "file_status:",
          message.file_status,
        );
        imgPreview.innerHTML = "";
        imgPreview.appendChild(createFileIcon(message));
      };
      imgPreview.appendChild(img);
      fileContainer.appendChild(imgPreview);
    } else {
      fileContainer.appendChild(createFileIcon(message));
    }
    contentDiv.appendChild(fileContainer);

    // 文件点击事件
    if (message.file_status === "sent" || message.file_status === "accepted") {
      fileContainer.style.cursor = "pointer";
      const tauri = window.__TAURI__;
      if (tauri) {
        if (message.file_path) {
          if (navigator.userAgent.includes("Android")) {
            fileContainer.addEventListener("click", async () => {
              try {
                await apiOpenFileInAndroid(message.file_path);
              } catch (e) {
                alert("打开失败: " + e.message);
              }
            });
            const shareBtn = document.createElement("button");
            shareBtn.className = "file-share-btn";
            shareBtn.title = "分享到其他应用";
            shareBtn.innerHTML =
              `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;
            shareBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              try {
                await apiShareFileToOtherApp(message.file_path);
              } catch (e) {
                alert("分享失败: " + e.message);
              }
            });
            const row = document.createElement("div");
            row.className = "file-action-row";
            if (isSent) {
              row.appendChild(shareBtn);
              while (fileContainer.firstChild) {
                row.appendChild(fileContainer.firstChild);
              }
            } else {
              while (fileContainer.firstChild) {
                row.appendChild(fileContainer.firstChild);
              }
              row.appendChild(shareBtn);
            }
            fileContainer.appendChild(row);
          } else {
            fileContainer.addEventListener(
              "click",
              () => openFileLocation(message.file_path),
            );
          }
        }
      } else if (message.file_id) {
        fileContainer.addEventListener(
          "click",
          () =>
            downloadFile(message.file_id, message.file_name || message.content),
        );
      }
    }
  } else if (
    message.msg_type === "text" &&
    message.content &&
    message.content.startsWith("[MODEL_LIST]")
  ) {
    console.log("[UI] ✓ 渲染模型选择按钮");
    // ── 模型选择按钮 ──
    const modelContainer = document.createElement("div");
    modelContainer.className = "model-select-container";

    // 内容格式: [MODEL_LIST]\n🟢 当前模型: ...\n[{"id":...}]
    // 用换行分割，跳过 [MODEL_LIST] 行，提取当前模型行和 JSON
    let currentModelLine = "";
    let jsonStr = "";
    const nlIdx = message.content.indexOf("\n");
    const rest = nlIdx > 0 ? message.content.slice(nlIdx + 1) : "";
    // rest 格式: "🟢 当前模型: ...\n[{"id":...}]"
    // 找 rest 中第一个 "[" 出现的位置（即 JSON 数组起始）
    const bracketIdx = rest.indexOf("\n[");
    if (bracketIdx > 0) {
      currentModelLine = rest.slice(0, bracketIdx).trim();
      jsonStr = rest.slice(bracketIdx + 1).trim();
    } else {
      jsonStr = rest.trim();
    }

    if (currentModelLine) {
      const currentEl = document.createElement("div");
      currentEl.className = "model-select-current";
      currentEl.textContent = currentModelLine;
      modelContainer.appendChild(currentEl);
    }

    const titleEl = document.createElement("div");
    titleEl.className = "model-select-title";
    titleEl.textContent = "📋 选择要切换的模型";
    modelContainer.appendChild(titleEl);

    // 解析 JSON
    let models = [];
    try {
      models = JSON.parse(jsonStr);
    } catch (e) {
      console.warn("[UI] 解析模型列表失败:", e);
    }

    if (models.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "model-select-empty";
      emptyEl.textContent = "⚠️ 没有可用模型";
      modelContainer.appendChild(emptyEl);
    } else {
      models.forEach((model) => {
        const btn = document.createElement("button");
        btn.className = "model-select-btn";
        btn.dataset.provider = model.provider || "";
        btn.dataset.modelId = model.id || "";

        // 显示名称
        const nameSpan = document.createElement("span");
        nameSpan.className = "model-select-btn-name";
        nameSpan.textContent = model.name || model.id || "Unknown";
        btn.appendChild(nameSpan);

        // 显示 provider
        const provSpan = document.createElement("span");
        provSpan.className = "model-select-btn-provider";
        provSpan.textContent = model.provider || "";
        btn.appendChild(provSpan);

        btn.addEventListener("click", async () => {
          if (window._switchingModel || btn.disabled) return;
          window._switchingModel = true;

          // 禁用所有模型按钮
          document.querySelectorAll(".model-select-btn").forEach((b) => {
            b.disabled = true;
          });

          const provider = btn.dataset.provider;
          const modelId = btn.dataset.modelId;
          const peerId = window.currentChatPeer ? window.currentChatPeer.id : "";
          const peerAddr = window.currentChatPeer ? window.currentChatPeer.addr : "";

          if (!peerId || !peerAddr) {
            console.warn("[UI] 无法发送模型选择: 当前聊天对象为空");
            window._switchingModel = false;
            return;
          }

          try {
            await apiSendMessage(
              peerId,
              peerAddr,
              `/model select ${provider} ${modelId}`,
            );
          } catch (e) {
            console.error("[UI] 发送模型选择失败:", e);
            window._switchingModel = false;
            document.querySelectorAll(".model-select-btn").forEach((b) => {
              b.disabled = false;
            });
          }
        });

        modelContainer.appendChild(btn);
      });
    }

    contentDiv.appendChild(modelContainer);
  } else {
    const textSpan = document.createElement("span");
    textSpan.className = "message-text";
    textSpan.textContent = message.content;
    contentDiv.appendChild(textSpan);
  }

  // ---- 统一处理纯净版的状态展示 ----
  const statusDiv = document.createElement("div");

  // 优先级 1: 只要数据库中 status 是 pending,一律展示"待上线"
  if (message.status === "pending") {
    statusDiv.className = "file-pending";
    statusDiv.textContent = "待上线";
  } // 优先级 2: 如果不是 pending 且是文件,展示上传/下载进度
  else if (message.msg_type === "file") {
    if (message.file_status === "downloading") {
      statusDiv.className = "file-downloading";
      statusDiv.textContent = message.transfer_speed
        ? Math.round(message.transfer_speed) + " MB/s"
        : "下载中...";
    } else if (message.file_status === "uploading") {
      statusDiv.className = "file-uploading";
      statusDiv.textContent = message.transfer_speed
        ? Math.round(message.transfer_speed) + " MB/s"
        : "上传中...";
    }
    // 成功状态(sent/accepted)不再塞入任何多余的文本,保持极简
  }

  if (statusDiv.className) {
    contentDiv.appendChild(statusDiv);
  }

  const timeDiv = document.createElement("div");
  timeDiv.className = "message-time";
  const date = new Date(message.timestamp * 1000);
  timeDiv.textContent = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  messageDiv.appendChild(contentDiv);
  messageDiv.appendChild(timeDiv);

  // 多选模式拦截
  if (window.selectMode && window.selectMode.active) {
    messageDiv.classList.add("selectable");
    addSelectCheckbox(messageDiv);
    if (
      message.id && window.selectMode.selectedMessages.has(parseInt(message.id))
    ) {
      messageDiv.classList.add("selected");
      const checkbox = messageDiv.querySelector(".select-checkbox");
      if (checkbox) checkbox.checked = true;
    }
  }

  return messageDiv;
}

// 接收到新消息
function onReceiveMessage(message) {
  console.log("[UI] ========== onReceiveMessage 被调用 ==========");
  console.log("[UI] 消息内容:", JSON.stringify(message, null, 2));
  console.log("[UI] 当前聊天对象:", window.currentChatPeer);
  // 仅在当前聊天窗口时处理
  if (window.currentChatPeer && window.currentChatPeer.id === message.from_id) {
    // —— 模型切换完成/失败时，重置按钮状态 ——
    if (window._switchingModel) {
      const text = message.content || "";
      if (text.startsWith("✅") || text.startsWith("❌")) {
        window._switchingModel = false;
        document.querySelectorAll(".model-select-btn").forEach((b) => {
          b.disabled = false;
        });
      }
    }

    // 流式消息处理
    if (message.is_streaming === true) {
      updateStreamMessage(message);
      const chatMessages = document.getElementById("chat-messages");
      const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop -
          chatMessages.clientHeight < 100;
      if (wasAtBottom) {
        setTimeout(async () => { await scrollToBottom(); }, 50);
      }
      return;
    }
    if (message.is_streaming === false) {
      // 流式结束：用永久消息替换流式气泡（带 data-msg-id，轮询回来时幂等）
      const chatMessages = document.getElementById("chat-messages");
      const existing = chatMessages.querySelector(`[data-stream-id="${message.stream_id}"]`);
      if (existing) {
        existing.replaceWith(createMessageElement(message, false));
      } else {
        chatMessages.appendChild(createMessageElement(message, false));
      }
      if (message.timestamp > (window.lastMessageTimestamp || 0)) {
        window.lastMessageTimestamp = message.timestamp;
      }
      const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop -
          chatMessages.clientHeight < 100;
      if (wasAtBottom) {
        setTimeout(async () => { await scrollToBottom(); }, 50);
      }
      return;
    }

    if (message.id === undefined || message.id === null) {
      console.log(
        "[UI] 收到一条暂时没有 ID 的实时通知,等待轮询系统自动同步...",
      );
      return;
    }

    if (message.msg_type === "file" && message.file_status === "downloading") {
      // 下载中的文件不渲染（等轮询更新状态时再处理）
      return;
    }

    const chatMessages = document.getElementById("chat-messages");
    const wasAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop -
        chatMessages.clientHeight < 100;

    addMessageToChat(message, false);

    if (wasAtBottom) {
        setTimeout(async () => {
          await scrollToBottom();
        }, 50);
      } else {
        const scrollBtn = document.getElementById("scroll-to-bottom-btn");
        const unreadDot = document.getElementById("unread-dot");
        if (scrollBtn) scrollBtn.classList.add("show");
        if (unreadDot) unreadDot.classList.add("show");
      }
  } else {
    console.log("[UI] ✗ 不匹配当前聊天对象");
    // 处理未读红点和排序
    const userLi = document.querySelector(
      `#user-list li[data-id="${message.from_id}"]`,
    );
    if (userLi) {
      userLi.classList.add("has-unread");
      sortUserList();
    }
    console.log("[UI]   - message.from_id:", message.from_id);
    console.log(
      "[UI]   - currentChatPeer.id:",
      window.currentChatPeer ? window.currentChatPeer.id : "null",
    );
  }
  console.log("[UI] ==========================================");
}

// 通过文件路径发送文件(桌面端零拷贝,直接从硬盘读取)
async function sendFileByPath(filePath) {
  if (!window.currentChatPeer) return;
  const tauri = window.__TAURI__;
  if (!tauri) return;

  try {
    let actualPath = filePath;
    if (filePath.startsWith("file://")) {
      actualPath = decodeURIComponent(filePath.substring(7));
      console.log("[UI] 转换 URI 为路径:", actualPath);
    }

    await apiSendFile(
      window.currentChatPeer.id,
      window.currentChatPeer.addr,
      null,
      actualPath,
    );

    // 纯洁地刷新
    await loadChatHistory(window.currentChatPeer.id, true);
    await scrollToBottom();
  } catch (e) {
    alert("文件发送失败: " + e.message);
    await loadChatHistory(window.currentChatPeer.id, true);
  }
}

// 发送文件
async function sendFile(file) {
  if (!window.currentChatPeer) return;

  const tauri = window.__TAURI__;

  if (tauri) {
    if (file) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const tempDir = await tauri.path.tempDir();
        const tempFilePath = await tauri.path.join(tempDir, file.name);
        await tauri.fs.writeFile(tempFilePath, uint8Array);

        // 调用后端命令
        await apiSendFile(
          window.currentChatPeer.id,
          window.currentChatPeer.addr,
          null,
          tempFilePath,
        );

        // 发送完刷新数据库渲染
        await loadChatHistory(window.currentChatPeer.id, true);
        await scrollToBottom();

        try {
          await tauri.fs.remove(tempFilePath);
        } catch (e) {}
      } catch (e) {
        alert("文件发送失败: " + e.message);
      }
    } else {
      try {
        await apiSendFile(
          window.currentChatPeer.id,
          window.currentChatPeer.addr,
          null,
        );
        await loadChatHistory(window.currentChatPeer.id, true);
        await scrollToBottom();
      } catch (e) {
        console.error("[UI] 文件发送失败:", e);
        alert("文件发送失败: " + e.message);
      }
    }
  } else {
    // Web 端
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      await fetch("/api/create_upload_record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          timestamp: timestamp,
          receiver_id: window.currentChatPeer.id,
        }),
      });
      // 让UI渲染出刚存入数据库的 uploading 状态
      await loadChatHistory(window.currentChatPeer.id, true);
      await scrollToBottom();

      await apiSendFile(
        window.currentChatPeer.id,
        window.currentChatPeer.addr,
        file,
      );

      await fetch("/api/update_upload_status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          timestamp: timestamp,
          status: "sent",
        }),
      });

      // 完成后再刷一次
      await loadChatHistory(window.currentChatPeer.id, true);
    } catch (e) {
      console.error("[UI] ✗ 文件发送失败:", e);
      alert("文件发送失败: " + e.message);
      await fetch("/api/delete_upload_record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: file.name, timestamp: timestamp }),
      });
      await loadChatHistory(window.currentChatPeer.id, true);
    }
  }
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// 下载文件
async function downloadFile(fileId, fileName) {
  try {
    const url = `/api/download/${fileId}`;

    // 使用 fetch 来获取下载进度
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    const totalSize = parseInt(contentLength, 10);

    const reader = response.body.getReader();
    const chunks = [];
    let receivedLength = 0;
    const startTime = Date.now();
    let lastLogTime = startTime;

    // 更新下载速度显示
    const updateDownloadSpeed = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        const speed = receivedLength / (1024 * 1024) / elapsed;
        const statusDivs = document.querySelectorAll(".file-downloading");
        statusDivs.forEach((div) => {
          div.textContent = Math.round(speed) + " MB/s";
        });
      }
    };

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      // 每秒更新一次速度显示
      const now = Date.now();
      if (now - lastLogTime > 1000) {
        updateDownloadSpeed();
        lastLogTime = now;
      }
    }

    // 合并所有分块
    const chunksAll = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      chunksAll.set(chunk, position);
      position += chunk.length;
    }

    // 创建 Blob 并下载
    const blob = new Blob([chunksAll]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    const totalTime = (Date.now() - startTime) / 1000;
    const avgSpeed = (receivedLength / (1024 * 1024)) / totalTime;
    console.log(
      "[UI] ✓ 文件下载完成:",
      fileName,
      "耗时:",
      totalTime.toFixed(2),
      "秒,平均速度:",
      avgSpeed.toFixed(2),
      "MB/s",
    );
  } catch (e) {
    console.error("[UI] 下载文件失败:", e);
    alert("下载失败: " + e.message);
  }
}

// 打开文件所在位置(仅桌面端)
async function openFileLocation(filePath) {
  const tauri = window.__TAURI__;

  if (!tauri) {
    alert("此功能仅在桌面端支持");
    return;
  }

  try {
    await tauri.core.invoke("open_file_location", { filePath: filePath });
    console.log("[UI] ✓ 打开文件位置:", filePath);
  } catch (e) {
    console.error("[UI] 打开文件位置失败:", e);
    alert("打开文件位置失败: " + e.message);
  }
}

// 初始化设置功能
function initSettings() {
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPanel = document.getElementById("settings-panel");
  const saveSettingsBtn = document.getElementById("save-settings-btn");
  const cancelSettingsBtn = document.getElementById("cancel-settings-btn");
  const choosePathBtn = document.getElementById("choose-path-btn");
  const downloadPathInput = document.getElementById("download-path-input");
  const settingsErrorMsg = document.getElementById("settings-error-msg");
  const settingsSuccessMsg = document.getElementById("settings-success-msg");

  // 打开/关闭设置面板 - 切换显示/隐藏
  settingsBtn.addEventListener("click", async () => {
    if (settingsPanel.style.display === "block") {
      // 当前是显示状态,点击后隐藏
      settingsPanel.style.display = "none";
      settingsErrorMsg.textContent = "";
      settingsSuccessMsg.textContent = "";
      settingsSuccessMsg.classList.remove("show");
    } else {
      // 当前是隐藏状态,点击后显示
      try {
        const settings = await apiGetSettings();
        downloadPathInput.value = settings.download_path;
        settingsPanel.style.display = "block";
        settingsErrorMsg.textContent = "";
        settingsSuccessMsg.textContent = "";
        settingsSuccessMsg.classList.remove("show");
      } catch (e) {
        settingsErrorMsg.textContent = "加载设置失败: " + e.message;
        settingsPanel.style.display = "block";
      }
    }
  });

  // 选择路径
  choosePathBtn.addEventListener("click", async () => {
    const tauri = window.__TAURI__;
    const isAndroid = tauri && navigator.userAgent.includes("Android");

    if (isAndroid) {
      // Android - 显示路径选择面板
      const androidPathPanel = document.getElementById("android-path-panel");
      androidPathPanel.style.display = "block";
    } else if (tauri) {
      // 桌面端 - 使用 Tauri 对话框
      try {
        const defaultPath = await apiGetDefaultDownloadPath();
        const selected = await tauri.dialog.open({
          directory: true,
          multiple: false,
          title: "选择下载文件夹",
          defaultPath: downloadPathInput.value || defaultPath,
        });

        if (selected) {
          const path = Array.isArray(selected) ? selected[0] : selected;
          downloadPathInput.value = path;
          settingsErrorMsg.textContent = "";
        }
      } catch (e) {
        console.error("[UI] 文件选择器错误:", e);
        settingsErrorMsg.textContent = "选择路径失败: " + e.message;
      }
    } else {
      // Web 端 - 只能手动输入
      const newPath = prompt("请输入下载路径:", downloadPathInput.value);
      if (newPath) {
        downloadPathInput.value = newPath;
      }
    }
  });

  // Android 路径选择面板逻辑
  const androidPathPanel = document.getElementById("android-path-panel");
  const pathOptions = document.querySelectorAll(".path-option");
  const customPathInput = document.getElementById("custom-path-input");
  const useCustomPathBtn = document.getElementById("use-custom-path-btn");
  const cancelAndroidPathBtn = document.getElementById(
    "cancel-android-path-btn",
  );

  pathOptions.forEach((option) => {
    option.addEventListener("click", () => {
      const path = option.getAttribute("data-path");
      downloadPathInput.value = path;
      androidPathPanel.style.display = "none";
    });
  });

  useCustomPathBtn.addEventListener("click", () => {
    const customPath = customPathInput.value.trim();
    if (customPath) {
      downloadPathInput.value = customPath;
      androidPathPanel.style.display = "none";
      customPathInput.value = "";
    }
  });

  cancelAndroidPathBtn.addEventListener("click", () => {
    androidPathPanel.style.display = "none";
    customPathInput.value = "";
  });

  // 保存设置
  saveSettingsBtn.addEventListener("click", async () => {
    try {
      settingsErrorMsg.textContent = "";
      settingsSuccessMsg.textContent = "";
      settingsSuccessMsg.classList.remove("show");

      await apiUpdateSettings(
        downloadPathInput.value,
      );

      // 显示成功消息
      settingsSuccessMsg.textContent = "✓ 设置保存成功";
      settingsSuccessMsg.classList.add("show");

      // 1.5秒后自动关闭设置面板
      setTimeout(() => {
        settingsPanel.style.display = "none";
        settingsSuccessMsg.classList.remove("show");
      }, 1500);

      console.log("[UI] 设置保存成功");
    } catch (e) {
      settingsErrorMsg.textContent = "保存失败: " + e.message;
    }
  });

  // 取消
  cancelSettingsBtn.addEventListener("click", () => {
    settingsPanel.style.display = "none";
    settingsErrorMsg.textContent = "";
    settingsSuccessMsg.textContent = "";
    settingsSuccessMsg.classList.remove("show");
  });
}

// 初始化主题功能
function initTheme() {
  const themeBtn = document.getElementById("theme-btn");
  const themePanel = document.getElementById("theme-panel");
  const applyThemeBtn = document.getElementById("apply-theme-btn");
  const cancelThemeBtn = document.getElementById("cancel-theme-btn");
  const themeList = document.getElementById("theme-list");
  const themeErrorMsg = document.getElementById("theme-error-msg");
  const themeSuccessMsg = document.getElementById("theme-success-msg");

  // 打开/关闭主题面板
  themeBtn.addEventListener("click", async () => {
    if (themePanel.style.display === "block") {
      themePanel.style.display = "none";
      themeErrorMsg.textContent = "";
      themeSuccessMsg.textContent = "";
      themeSuccessMsg.classList.remove("show");
    } else {
      try {
        await loadThemeList();
        themePanel.style.display = "block";
        themeErrorMsg.textContent = "";
        themeSuccessMsg.textContent = "";
        themeSuccessMsg.classList.remove("show");
      } catch (e) {
        themeErrorMsg.textContent = "加载主题列表失败: " + e.message;
        themePanel.style.display = "block";
      }
    }
  });

  // 应用主题
  applyThemeBtn.addEventListener("click", async () => {
    const selectedTheme = document.querySelector('input[name="theme"]:checked');
    if (!selectedTheme) {
      themeErrorMsg.textContent = "请选择一个主题";
      return;
    }

    try {
      themeErrorMsg.textContent = "";
      themeSuccessMsg.textContent = "";
      themeSuccessMsg.classList.remove("show");

      await applyTheme(selectedTheme.value);
      await apiSaveCurrentTheme(selectedTheme.value);

      themeSuccessMsg.textContent = "✓ 主题应用成功";
      themeSuccessMsg.classList.add("show");

      setTimeout(() => {
        themePanel.style.display = "none";
        themeSuccessMsg.classList.remove("show");
      }, 1500);

      console.log("[UI] 主题应用成功:", selectedTheme.value);
    } catch (e) {
      themeErrorMsg.textContent = "应用主题失败: " + e.message;
      console.error("[UI] 应用主题失败:", e);
    }
  });

  // 取消
  cancelThemeBtn.addEventListener("click", () => {
    themePanel.style.display = "none";
    themeErrorMsg.textContent = "";
    themeSuccessMsg.textContent = "";
    themeSuccessMsg.classList.remove("show");
  });

  // 页面加载时应用保存的主题
  loadSavedTheme();
}

// 加载主题列表
async function loadThemeList() {
  const themeList = document.getElementById("theme-list");
  const themes = await apiGetThemeList();
  const currentTheme = await apiGetCurrentTheme();

  themeList.innerHTML = "";

  for (const theme of themes) {
    const themeItem = document.createElement("div");
    themeItem.className = "theme-item";

    const isSelected = theme.name === currentTheme;

    themeItem.innerHTML = `
            <input type="radio" id="theme-${theme.name}" name="theme" value="${theme.name}" ${
      isSelected ? "checked" : ""
    }>
            <label for="theme-${theme.name}">${theme.display_name}${
      theme.is_custom ? " (自定义)" : ""
    }</label>
        `;

    if (isSelected) {
      themeItem.classList.add("active");
    }

    // 点击整个项目也能选中
    themeItem.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        const radio = themeItem.querySelector('input[type="radio"]');
        radio.checked = true;

        // 更新active状态
        document.querySelectorAll(".theme-item").forEach((item) =>
          item.classList.remove("active")
        );
        themeItem.classList.add("active");
      }
    });

    // 监听radio变化
    const radio = themeItem.querySelector('input[type="radio"]');
    radio.addEventListener("change", () => {
      if (radio.checked) {
        document.querySelectorAll(".theme-item").forEach((item) =>
          item.classList.remove("active")
        );
        themeItem.classList.add("active");
      }
    });

    themeList.appendChild(themeItem);
  }

  console.log("[UI] 加载了", themes.length, "个主题,当前主题:", currentTheme);
}

// 应用主题
async function applyTheme(themeName) {
  // 移除现有的自定义主题样式
  const existingCustomStyle = document.getElementById("custom-theme-style");
  if (existingCustomStyle) {
    existingCustomStyle.remove();
  }

  // 获取默认样式表
  const defaultStylesheet = document.querySelector(
    'link[href="css/style.css"]',
  );

  if (themeName === "default") {
    // 恢复默认主题:启用默认CSS
    if (defaultStylesheet) {
      defaultStylesheet.disabled = false;
    }
    console.log("[UI] 应用默认主题");
    return;
  }

  // 获取自定义主题CSS
  const css = await apiGetThemeCss(themeName);

  // 禁用默认样式表
  if (defaultStylesheet) {
    defaultStylesheet.disabled = true;
  }

  // 创建新的style元素
  const styleElement = document.createElement("style");
  styleElement.id = "custom-theme-style";
  styleElement.textContent = css;

  // 添加到head中
  document.head.appendChild(styleElement);

  console.log("[UI] 应用自定义主题:", themeName, "(已禁用默认CSS)");
}

// 加载保存的主题
async function loadSavedTheme() {
  try {
    const currentTheme = await apiGetCurrentTheme();
    if (currentTheme && currentTheme !== "default") {
      await applyTheme(currentTheme);
      console.log("[UI] 自动加载保存的主题:", currentTheme);
    }
  } catch (e) {
    console.warn("[UI] 加载保存的主题失败:", e);
  }
}

// 初始化拖拽文件功能
function initDragAndDrop(chatContainer) {
  console.log("[UI] 初始化拖拽文件功能");

  const tauri = window.__TAURI__;

  if (tauri) {
    // 桌面端:使用 Tauri 的原生拖拽事件(可以获取文件路径)
    console.log("[UI] 使用 Tauri 原生拖拽事件");

    // 监听 Tauri 的文件拖放事件
    tauri.event.listen("tauri://drag-drop", async (event) => {
      console.log("[UI] Tauri 拖放事件:", event);

      if (!window.currentChatPeer) {
        console.log("[UI] 没有打开聊天窗口,忽略拖放");
        return;
      }

      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        console.log("[UI] 拖放的文件路径:", paths);

        // 依次发送所有文件(使用文件路径,零拷贝)
        for (const filePath of paths) {
          console.log("[UI] 发送文件:", filePath);
          await sendFileByPath(filePath);
        }
      }
    });

    // 监听拖拽悬停事件(显示视觉反馈)
    tauri.event.listen("tauri://drag-enter", () => {
      if (window.currentChatPeer) {
        chatContainer.classList.add("drag-over");
      }
    });

    tauri.event.listen("tauri://drag-leave", () => {
      chatContainer.classList.remove("drag-over");
    });

    tauri.event.listen("tauri://drag-drop", () => {
      chatContainer.classList.remove("drag-over");
    });
  } else {
    // Web 端:使用传统的 HTML5 拖拽 API(需要读取文件内容)
    console.log("[UI] 使用 HTML5 拖拽 API");

    // 防止默认的拖拽行为(打开文件)
    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
      chatContainer.addEventListener(eventName, preventDefaults, false);
      document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // 拖拽进入时高亮
    ["dragenter", "dragover"].forEach((eventName) => {
      chatContainer.addEventListener(eventName, () => {
        if (window.currentChatPeer) {
          chatContainer.classList.add("drag-over");
        }
      }, false);
    });

    // 拖拽离开时取消高亮
    ["dragleave", "drop"].forEach((eventName) => {
      chatContainer.addEventListener(eventName, () => {
        chatContainer.classList.remove("drag-over");
      }, false);
    });

    // 处理文件拖放
    chatContainer.addEventListener("drop", async (e) => {
      if (!window.currentChatPeer) {
        console.log("[UI] 没有打开聊天窗口,忽略拖放");
        return;
      }

      const files = e.dataTransfer.files;

      if (files && files.length > 0) {
        console.log("[UI] 拖放了", files.length, "个文件");

        // 依次发送所有文件
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          console.log("[UI] 拖放的文件:", file.name, file.size);
          await sendFile(file);
        }
      } else {
        console.log("[UI] 没有检测到文件");
      }
    }, false);
  }
}

// 初始化粘贴文件功能
function initPasteFile() {
  console.log("[UI] 初始化粘贴文件功能");

  const tauri = window.__TAURI__;

  // 监听全局粘贴事件
  document.addEventListener("paste", async (e) => {
    // 只在聊天窗口打开时处理
    if (!window.currentChatPeer) {
      console.log("[UI] 没有打开聊天窗口,忽略粘贴");
      return;
    }

    // 桌面端:优先尝试使用 clipboard-rs 读取文件路径(零拷贝)
    if (tauri) {
      try {
        console.log("[UI] 尝试从剪贴板读取文件路径");
        const filePaths = await tauri.core.invoke("read_clipboard_files");

        if (filePaths && filePaths.length > 0) {
          console.log("[UI] 剪贴板中的文件路径:", filePaths);
          e.preventDefault(); // 阻止默认粘贴行为

          // 使用零拷贝方式发送文件
          for (const filePath of filePaths) {
            await sendFileByPath(filePath);
          }
          return;
        } else {
          console.log("[UI] 剪贴板中没有文件");
        }
      } catch (err) {
        console.log("[UI] 读取剪贴板文件路径失败,尝试使用传统方式:", err);
        // 继续使用传统方式处理
      }
    }

    // 传统方式:从 ClipboardEvent 读取文件(需要读取内容)
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) {
      console.log("[UI] 无法访问剪贴板");
      return;
    }

    // 检查是否有文件
    const items = clipboardData.items;
    if (!items || items.length === 0) {
      console.log("[UI] 剪贴板中没有内容");
      return;
    }

    let hasFile = false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log("[UI] 剪贴板项目类型:", item.type, item.kind);

      if (item.kind === "file") {
        hasFile = true;
        e.preventDefault(); // 阻止默认粘贴行为

        const file = item.getAsFile();
        if (file) {
          console.log("[UI] 粘贴的文件:", file.name, file.size, file.type);
          await sendFile(file);
        }
      }
    }

    if (hasFile) {
      console.log("[UI] 已处理粘贴的文件");
    }
  });

  // 添加快捷键提示
  console.log("[UI] Ctrl+V 粘贴文件功能已启用(支持零拷贝)");
}

// 初始化"回到底部"悬浮按钮
function initScrollToBottomBtn() {
  const chatMessages = document.getElementById("chat-messages");
  const inputContainer = document.querySelector(".chat-input-container");

  if (!chatMessages || !inputContainer) {
    console.warn("[UI] 无法初始化回到底部按钮:找不到必要的元素");
    return;
  }

  // 检查是否已经创建过按钮,避免重复创建
  let btn = document.getElementById("scroll-to-bottom-btn");
  if (btn) {
    console.log("[UI] 回到底部按钮已存在,跳过创建");
    return;
  }

  // 1. 动态创建按钮 DOM
  btn = document.createElement("div");
  btn.id = "scroll-to-bottom-btn";
  btn.className = "scroll-bottom-btn";
  // 注入一个向下箭头的 SVG 图标 和 未读小红点
  btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
        <div id="unread-dot" class="unread-dot"></div>
    `;

  // 将按钮插入到 chat-messages 的平级,输入框的上方
  inputContainer.appendChild(btn);
  console.log("[UI] 回到底部按钮已创建");

  // 2. 绑定点击事件:平滑滚动到底部
  btn.addEventListener("click", () => {
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: "smooth", // 增加平滑滚动效果
    });
    // 隐藏未读红点
    const unreadDot = document.getElementById("unread-dot");
    if (unreadDot) {
      unreadDot.classList.remove("show");
      console.log("[UI] 已隐藏未读红点");
    }
  });

  // 3. 监听滚动事件,控制显示/隐藏
  chatMessages.addEventListener("scroll", () => {
    // 距离底部 150px 以内都认为是在底部
    const isAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop -
        chatMessages.clientHeight < 150;

    if (isAtBottom) {
      // 滚到底部了,隐藏按钮
      btn.classList.remove("show");

      // 滚到底部时必须清除红点状态
      const unreadDot = document.getElementById("unread-dot");
      if (unreadDot) {
        unreadDot.classList.remove("show");
      }
    } else {
      // 不在底部,按钮应该显示(但不一定有红点,红点由新消息触发)
      btn.classList.add("show");
    }
  });
}

// 多选模式相关
window.selectMode = {
  active: false,
  selectedMessages: new Set(),
};

// 初始化多选模式
function initSelectMode() {
  const selectModeBtn = document.getElementById("select-mode-btn");

  // 确保按钮存在
  if (!selectModeBtn) return;

  // 点击多选按钮
  selectModeBtn.addEventListener("click", () => {
    if (window.selectMode.active) {
      exitSelectMode();
    } else {
      enterSelectMode();
    }
  });
}

// 进入多选模式
function enterSelectMode(initialMessageId = null) {
  console.log("[UI] 进入多选模式");
  window.selectMode.active = true;
  window.selectMode.selectedMessages.clear();

  // 只要是移动端(包括安卓平板)或者屏幕够小,都写入历史记录,防止物理返回键直接退出 App
  const isMobile = navigator.userAgent.includes("Android") ||
    window.innerWidth <= 768;
  if (isMobile) {
    window.history.pushState({ selectMode: true }, "", "#chat-select");
  }

  // 更新UI
  const selectModeBtn = document.getElementById("select-mode-btn");
  const sendBtn = document.getElementById("send-btn");
  const chatInput = document.getElementById("chat-input");
  const attachFileBtn = document.getElementById("attach-file-btn");

  // 切换为取消图标,并添加激活样式
  selectModeBtn.innerHTML = ICON_CANCEL_X;
  selectModeBtn.classList.add("active");

  // 发送按钮变为删除,改为红色警告色
  sendBtn.textContent = "删除";
  sendBtn.style.backgroundColor = "#ff5555"; // Dracula Red
  sendBtn.style.borderColor = "#ff5555";
  sendBtn.style.color = "#fff";

  chatInput.disabled = true;
  attachFileBtn.disabled = true;

  // 禁用模型选择按钮
  document.querySelectorAll(".model-select-btn").forEach((b) => {
    b.disabled = true;
  });
  // 给所有消息添加复选框和点击事件
  const messages = document.querySelectorAll(".message");
  messages.forEach((msg) => {
    addSelectCheckbox(msg);
    msg.classList.add("selectable");

    if (initialMessageId && msg.dataset.msgId === String(initialMessageId)) {
      msg.classList.add("selected");
      const checkbox = msg.querySelector(".select-checkbox");
      if (checkbox) checkbox.checked = true;
      // 立即将初始消息加入集合
      window.selectMode.selectedMessages.add(parseInt(initialMessageId));
    }
  });
}

// 退出多选模式
function exitSelectMode() {
  console.log("[UI] 退出多选模式");
  window.selectMode.active = false;
  window.selectMode.selectedMessages.clear();

  // 如果当前 URL 是 #chat-select,说明是移动端通过按钮退出的,需要后退一步恢复到 #chat
  // 如果是按返回键触发的 popstate,URL 已经变了,就不需要 back()
  if (window.location.hash === "#chat-select") {
    window.history.back();
  }

  // 恢复UI
  const selectModeBtn = document.getElementById("select-mode-btn");
  const sendBtn = document.getElementById("send-btn");
  const chatInput = document.getElementById("chat-input");
  const attachFileBtn = document.getElementById("attach-file-btn");

  // 恢复列表图标
  selectModeBtn.innerHTML = ICON_SELECT_LIST;
  selectModeBtn.classList.remove("active");

  // 恢复发送按钮
  sendBtn.textContent = "发送";
  sendBtn.style.backgroundColor = ""; // 恢复 CSS 中的默认值
  sendBtn.style.borderColor = "";
  sendBtn.style.color = "";

  chatInput.disabled = false;
  attachFileBtn.disabled = false;

  // 恢复模型选择按钮（非切换中才启用）
  if (!window._switchingModel) {
    document.querySelectorAll(".model-select-btn").forEach((b) => {
      b.disabled = false;
    });
  }

  // 移除复选框逻辑保持不变
  const messages = document.querySelectorAll(".message");
  messages.forEach((msg) => {
    removeSelectCheckbox(msg);
    msg.classList.remove("selectable", "selected");
  });
}

// 添加复选框到消息
function addSelectCheckbox(messageElement) {
  if (messageElement.querySelector(".select-checkbox")) return;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "select-checkbox";

  // 点击复选框
  checkbox.addEventListener("change", (e) => {
    e.stopPropagation();
    toggleMessageSelection(messageElement);
  });

  // 点击消息本身
  messageElement.addEventListener("click", handleMessageClick);

  messageElement.insertBefore(checkbox, messageElement.firstChild);
}

// 移除复选框
function removeSelectCheckbox(messageElement) {
  const checkbox = messageElement.querySelector(".select-checkbox");
  if (checkbox) {
    checkbox.remove();
  }
  messageElement.removeEventListener("click", handleMessageClick);
}

// 处理消息点击
function handleMessageClick(e) {
  if (!window.selectMode.active) return;

  // 如果点击的是复选框,不处理(复选框自己会处理)
  if (e.target.classList.contains("select-checkbox")) return;

  const messageElement = e.currentTarget;
  toggleMessageSelection(messageElement);
}

// 切换消息选中状态
function toggleMessageSelection(messageElement) {
  const msgId = parseInt(messageElement.dataset.msgId);

  // 如果节点缺少合法 ID,直接刷新界面纠正数据,然后退出
  if (!msgId || isNaN(msgId)) {
    console.warn("[UI] 发现没有合法 ID 的幽灵消息,强制刷新界面...");
    if (window.currentChatPeer) {
      loadChatHistory(window.currentChatPeer.id, true);
    }
    return;
  }

  const checkbox = messageElement.querySelector(".select-checkbox");

  if (window.selectMode.selectedMessages.has(msgId)) {
    window.selectMode.selectedMessages.delete(msgId);
    messageElement.classList.remove("selected");
    if (checkbox) checkbox.checked = false;
    console.log("[UI] 取消选中消息:", msgId);
  } else {
    window.selectMode.selectedMessages.add(msgId);
    messageElement.classList.add("selected");
    if (checkbox) checkbox.checked = true;
    console.log("[UI] 选中消息:", msgId);
  }

  console.log(
    "[UI] 已选中消息:",
    Array.from(window.selectMode.selectedMessages),
  );
}

// 删除选中的消息
async function deleteSelectedMessages() {
  const selectedIds = Array.from(window.selectMode.selectedMessages);

  if (selectedIds.length === 0) {
    alert("请先选择要删除的消息");
    return;
  }

  try {
    console.log("[UI] 删除消息:", selectedIds);

    // 调用API删除
    await apiDeleteMessages(selectedIds);

    // 从DOM中移除
    selectedIds.forEach((msgId) => {
      const msgElement = document.querySelector(
        `.message[data-msg-id="${msgId}"]`,
      );
      if (msgElement) {
        msgElement.remove();
      }
    });

    // 手动派发 scroll 事件,强制更新"回到底部"按钮的状态
    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) {
      chatMessages.dispatchEvent(new Event("scroll"));
    }

    // 更新已加载数量
    if (window.currentChatMessages) {
      window.currentChatMessages.loadedCount -= selectedIds.length;
      window.currentChatMessages.totalCount -= selectedIds.length;
    }

    console.log("[UI] 消息删除成功");

    // 退出多选模式
    exitSelectMode();
  } catch (e) {
    console.error("[UI] 删除消息失败:", e);
    alert("删除消息失败: " + e.message);
  }
}

// 长按进入多选模式(移动端)暂未使用
function initLongPressSelectMode() {
  let longPressTimer = null;
  let longPressTarget = null;

  document.addEventListener("touchstart", (e) => {
    // 只在聊天消息上触发
    const messageElement = e.target.closest(".message");
    if (!messageElement || window.selectMode.active) return;

    longPressTarget = messageElement;
    longPressTimer = setTimeout(() => {
      const msgId = parseInt(messageElement.dataset.msgId);
      if (msgId) {
        enterSelectMode(msgId);
      }
    }, 500); // 500ms 长按
  });

  document.addEventListener("touchend", () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressTarget = null;
    }
  });

  document.addEventListener("touchmove", () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressTarget = null;
    }
  });
}

// ==========================================
// 1. 完全独立的二次确认弹窗工具函数
// ==========================================
function showConfirm(message, onOk) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-dialog-overlay";

  overlay.innerHTML = `
        <div class="confirm-dialog-content">
            <p>${message}</p>
            <div class="confirm-button-group">
                <button class="confirm-btn-ok" id="confirm-ok">确定</button>
                <button class="confirm-btn-cancel" id="confirm-cancel">取消</button>
            </div>
        </div>
    `;

  document.body.appendChild(overlay);

  // 取消:直接移除 DOM
  document.getElementById("confirm-cancel").onclick = () => overlay.remove();

  // 确定:拦截处理状态,并执行传入的 onOk 回调
  document.getElementById("confirm-ok").onclick = async () => {
    const btn = document.getElementById("confirm-ok");
    btn.disabled = true;
    btn.textContent = "处理中...";
    try {
      await onOk(); // 这里才真正执行删除动作
    } catch (e) {
      console.error("执行失败:", e);
      alert("操作失败: " + e.message);
    } finally {
      overlay.remove(); // 无论成功失败,都关闭确认弹窗
    }
  };
}

// ==========================================
// 2. 完整的用户管理弹窗函数
// ==========================================
async function showUserActionDialog(peerId, userName) {
  // 1. 判断是否离线(通过检查左侧列表中是否有 offline 灰显类名)
  const userLi = document.querySelector(`#user-list li[data-id="${peerId}"]`);
  const isOffline = userLi ? userLi.classList.contains("offline") : true;

  // 2. 检测是否有聊天记录
  const history = await apiGetChatHistory(peerId, 1, 0);
  const hasHistory = history && history.length > 0;

  // 如果是在线用户,且连聊天记录都没有,那完全没有任何可管理的操作,直接忽略长按/右键
  if (!isOffline && !hasHistory) {
    console.log(`[UI] 在线用户 "${userName}" 无聊天记录,无需弹出管理菜单`);
    return;
  }

  const old = document.getElementById("user-mgmt-panel");
  if (old) old.remove();

  // 绘制管理弹窗
  const panel = document.createElement("div");
  panel.id = "user-mgmt-panel";
  panel.className = "edit-panel";
  panel.style.display = "block";

  // 动态生成按钮的 HTML
  let buttonsHtml = "";

  // 只有"离线用户"才允许显示删除按钮
  if (isOffline) {
    buttonsHtml +=
      `<button id="mgmt-del-btn" class="mgmt-action-btn btn-grad-danger">删除用户</button>`;
  }

  // 只要有历史记录,就允许清空
  if (hasHistory) {
    buttonsHtml +=
      `<button id="mgmt-clear-btn" class="mgmt-action-btn btn-grad-warning">清空聊天记录</button>`;
  }

  buttonsHtml +=
    `<button id="mgmt-cancel-btn" class="btn-cancel-custom">取消</button>`;

  panel.innerHTML = `
        <h2>管理 ${userName}</h2>
        <div style="display: flex; flex-direction: column; gap: 15px; margin-top: 20px;">
            ${buttonsHtml}
        </div>
    `;

  document.body.appendChild(panel);

  const closeMgmt = () => panel.remove();
  document.getElementById("mgmt-cancel-btn").onclick = closeMgmt;

  // --- 绑定删除逻辑 (注意加判空,因为在线用户没有这个按钮) ---
  const delBtn = document.getElementById("mgmt-del-btn");
  if (delBtn) {
    delBtn.onclick = () => {
      showConfirm(
        `确定要彻底删除离线用户 "${userName}" 吗?此操作不可恢复。`,
        async () => {
          if (window.currentChatPeer && window.currentChatPeer.id === peerId) {
            performCloseChatUI();
          }

          await apiDeleteUserComplete(peerId);

          const el = document.querySelector(
            `#user-list li[data-id="${peerId}"]`,
          );
          if (el) el.remove();

          sortUserList();

          closeMgmt();
        },
      );
    };
  }

  // --- 绑定清空记录逻辑---
  const clearBtn = document.getElementById("mgmt-clear-btn");
  if (clearBtn) {
    clearBtn.onclick = () => {
      showConfirm(`确定要清空与 "${userName}" 的所有聊天记录吗?`, async () => {
        await apiClearChatHistory(peerId);

        if (window.currentChatPeer && window.currentChatPeer.id === peerId) {
          const box = document.getElementById("chat-messages");
          if (box) box.innerHTML = "";
          window.lastMessageTimestamp = 0;
        }
        closeMgmt();
      });
    };
  }
}
