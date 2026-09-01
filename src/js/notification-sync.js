/* Notification views intentionally never set currentChatPeer or read chat history. */
window.NotificationUI = (() => {
  let enabled = false,
    android = false,
    localId = "",
    peers = [],
    records = [],
    current = null;
  let config = {
    push_enabled: false,
    receive_enabled: false,
    allowed_packages: [],
    target_device_ids: [],
  };
  let detailSignature = "";
  let info = {},
    dialog,
    appDialog,
    panel,
    welcome,
    pushList,
    receiveList,
    refreshTimer,
    busy = false;
  const statusText = {
    sending: "处理中",
    success: "成功",
    failure: "失败",
    timeout: "超时",
    offline: "离线已丢弃",
    busy: "繁忙已丢弃",
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (text, action, cls = "ns-button") => {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const invoke = (command, args = {}) =>
    window.__TAURI__.core.invoke(command, args);
  const peerFor = (id) => peers.find((p) => p.id === id);
  const nameFor = (id) =>
    peerFor(id)?.name || records.find((r) => r.peer_id === id)?.peer_name || id;
  const isNarrow = () => android || innerWidth < 960;
  function group(title, sending) {
    const box = el("section", "ns-group");
    const head = el("div", "ns-group-heading");
    const disclosure = button(
      title,
      () => {
        const expanded = disclosure.getAttribute("aria-expanded") === "true";
        disclosure.setAttribute("aria-expanded", String(!expanded));
        list.hidden = expanded;
      },
      "ns-disclosure",
    );
    disclosure.setAttribute("aria-expanded", "true");
    head.append(disclosure, button("设置", openSettings, "ns-text-button"));
    const list = el("div", "ns-device-list");
    list.dataset.kind = sending ? "notification_push" : "notification_receive";
    box.append(head, list);
    return { box, list };
  }
  function renderDevices() {
    if (!enabled) return;
    const fill = (list, ids, kind) => {
      const wanted = new Set(ids);
      for (const row of [...list.children])
        if (!wanted.has(row.dataset.peer)) row.remove();
      if (!ids.length) {
        if (!list.firstChild)
          list.append(
            el(
              "p",
              "ns-empty-small",
              kind === "notification_push"
                ? "在设置中选择推送设备"
                : config.receive_enabled
                  ? "等待其他设备推送通知"
                  : "尚未开启信息接收",
            ),
          );
        else
          list.firstChild.textContent = config.receive_enabled
            ? "等待其他设备推送通知"
            : "尚未开启信息接收";
        return;
      }
      for (const id of ids) {
        let row = [...list.children].find((n) => n.dataset.peer === id);
        if (!row) {
          row = button("", () => open(id, kind), "ns-device");
          row.dataset.peer = id;
          const copy = el("span", "ns-device-copy");
          copy.append(el("strong", "ns-name"), el("small", "ns-address"));
          row.append(copy, el("span", "ns-badge"));
          list.append(row);
        }
        const peer = peerFor(id),
          name = nameFor(id),
          online = peer && !peer.is_offline;
        const label = `${name}（${kind === "notification_push" ? "信息推送" : "信息接收"}）`;
        row.querySelector(".ns-name").textContent = label;
        row.title = label;
        row.querySelector(".ns-address").textContent =
          peer?.addr || "当前地址未知";
        const badge = row.querySelector(".ns-badge");
        badge.textContent =
          kind === "notification_push"
            ? `${config.push_enabled ? "已开启" : "已暂停"} · ${online ? "在线" : "离线"}`
            : online
              ? "在线"
              : "离线";
        badge.classList.toggle("online", !!online);
        row.classList.toggle(
          "selected",
          current?.id === id && current?.kind === kind,
        );
        row.setAttribute(
          "aria-pressed",
          String(current?.id === id && current?.kind === kind),
        );
      }
    };
    if (android)
      fill(
        pushList,
        [...new Set(config.target_device_ids)].filter((id) => id !== localId),
        "notification_push",
      );
    fill(
      receiveList,
      [
        ...new Set(
          records
            .filter((r) => r.view_kind === "notification_receive")
            .map((r) => r.peer_id),
        ),
      ],
      "notification_receive",
    );
    if (current) renderDetail();
    welcome.querySelector(".ns-welcome-hint").textContent =
      config.receive_enabled
        ? "在手机的信息推送设置中勾选本机，即可在这里接收通知。"
        : "开启信息接收，让手机上的重要通知出现在电脑上。";
  }
  function leave() {
    if (!enabled) return;
    current = null;
    panel.hidden = true;
    document.body.classList.remove("notification-open");
    renderDevices();
  }
  function open(id, kind) {
    if (!enabled) return;
    if (window.currentChatPeer) performCloseChatUI();
    current = { id, kind };
    panel.hidden = false;
    document.body.classList.add("notification-open");
    if (isNarrow() && location.hash !== "#notifications")
      history.pushState({ notifications: true }, "", "#notifications");
    detailSignature = "";
    panel.querySelector(".ns-cards").replaceChildren();
    panel.querySelector(".ns-cards").scrollTop = 0;
    renderDevices();
  }
  function close() {
    if (location.hash === "#notifications") history.back();
    else leave();
  }
  function renderDetail() {
    if (!current) return;
    const p = peerFor(current.id),
      push = current.kind === "notification_push";
    panel.querySelector(".ns-detail-title").textContent =
      `${nameFor(current.id)}（${push ? "信息推送" : "信息接收"}）`;
    panel.querySelector(".ns-detail-status").textContent =
      `${p && !p.is_offline ? "设备在线" : "设备离线，不会补收离线通知"} · ${push ? (config.push_enabled ? "推送已开启" : "推送已暂停") : config.receive_enabled ? "接收已开启" : "接收已关闭"}`;
    const list = panel.querySelector(".ns-cards"),
      oldTop = list.scrollTop;
    const entries = records.filter(
      (r) => r.peer_id === current.id && r.view_kind === current.kind,
    );
    const signature = JSON.stringify([current, entries]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    const anchor = [...list.children].find(
      (n) =>
        n.getBoundingClientRect().bottom >= list.getBoundingClientRect().top,
    );
    const anchorTop = anchor?.getBoundingClientRect().top;
    const keys = new Set();
    let added = false;
    for (const entry of entries) {
      const n = entry.notification,
        key = entry.record_id || (push
          ? n.event_id
          : JSON.stringify([n.source_device_id, n.package, n.notification_key]));
      keys.add(key);
      let card = [...list.children].find((c) => c.dataset.key === key);
      if (!card) {
        card = el("article", "ns-card");
        card.dataset.key = key;
        if (entry.record_id) card.dataset.recordId = entry.record_id;
        const meta = el("div", "ns-app-rail");
        const appIcon = el("span", "ns-app-icon");
        const image = el("img");
        image.alt = "";
        image.hidden = true;
        image.addEventListener("error", () => {
          image.hidden = true;
          appIcon.querySelector(".ns-icon-fallback").hidden = false;
        });
        image.addEventListener("load", () => {
          image.hidden = false;
          appIcon.querySelector(".ns-icon-fallback").hidden = true;
        });
        appIcon.append(image, el("span", "ns-icon-fallback"));
        meta.append(appIcon, el("strong", "ns-app"), el("time", "ns-time"));
        const more = button(
          "展开正文",
          () => {
            const expanded = card.classList.toggle("expanded");
            more.textContent = expanded ? "收起正文" : "展开正文";
            more.setAttribute("aria-expanded", String(expanded));
          },
          "ns-text-button ns-more",
        );
        more.setAttribute("aria-expanded", "false");
        const copy = el("div", "ns-notification-copy");
        const box = el("div", "ns-content-box");
        box.append(el("p", "ns-body"), more, el("small", "ns-result"));
        copy.append(el("h3", "ns-title"), box);
        card.append(meta, copy);
        added = true;
      }
      card.querySelector(".ns-app").textContent = n.app_name || n.package;
      const appIcon = card.querySelector(".ns-app-icon");
      const image = appIcon.querySelector("img");
      const fallback = appIcon.querySelector(".ns-icon-fallback");
      fallback.textContent = Array.from(n.app_name || n.package || "应用")[0];
      const encoded = typeof n.app_icon === "string" && n.app_icon.length <= 10924 && /^iVBOR[A-Za-z0-9+/]*={0,2}$/.test(n.app_icon) ? n.app_icon : "";
      if (image.dataset.icon !== encoded) {
        image.dataset.icon = encoded;
        image.hidden = true;
        fallback.hidden = false;
        if (encoded) image.src = `data:image/png;base64,${encoded}`;
        else image.removeAttribute("src");
      }
      const date = new Date(n.post_time);
      card.querySelector(".ns-time").textContent = Number.isFinite(
        date.getTime(),
      )
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
        : "";
      card.querySelector(".ns-time").title = Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
      card.querySelector(".ns-title").textContent = n.title;
      card.querySelector(".ns-body").textContent = n.text;
      // Check rendered overflow after insertion; short multi-line text can also be clipped.
      card.querySelector(".ns-result").textContent = push
        ? statusText[entry.status] || "失败"
        : "";
      list.append(card);
      const body = card.querySelector(".ns-body");
      card.querySelector(".ns-more").hidden = !card.classList.contains("expanded") && body.scrollHeight <= body.clientHeight + 1;
    }
    for (const child of [...list.children])
      if (!keys.has(child.dataset.key)) child.remove();
    if (!entries.length)
      list.append(
        el(
          "div",
          "ns-empty",
          push
            ? "暂无推送记录。仅推送已允许 App 的新通知。"
            : config.receive_enabled
              ? "尚未收到通知。请在手机推送设置中勾选本机。"
              : "接收已关闭。可在接收设置中开启。",
        ),
      );
    list.scrollTop = oldTop;
    if (anchor?.isConnected && oldTop > 30)
      list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    const newer = panel.querySelector(".ns-new");
    if (added && oldTop > 30) newer.hidden = false;
  }
  async function refreshRecords() {
    if (!enabled) return;
    try {
      const page = await invoke("notification_records", { query: { page: 1, page_size: 100 } });
      records = Array.isArray(page) ? page : page.records || [];
      renderDevices();
    } catch (_) {
      /* Keep the current view when the bridge is temporarily unavailable. */
    }
  }
  async function handleSyncedActivation(detail) {
    const source = detail?.sourceDeviceId;
    const recordId = detail?.recordId;
    if (!source) return;
    try { await invoke("notification_pending_activation"); } catch (_) {}
    await refreshRecords();
    if (recordId && !records.some((item) => item.record_id === recordId)) {
      try {
        const exact = await invoke("notification_record", { recordId });
        if (exact) records.unshift(exact);
      } catch (_) {}
    }
    open(source, "notification_receive");
    requestAnimationFrame(() => {
      const card = recordId
        ? panel.querySelector(`[data-record-id="${CSS.escape(recordId)}"]`)
        : null;
      if (card) {
        card.tabIndex = -1;
        card.scrollIntoView({ block: "center" });
        card.focus({ preventScroll: true });
      }
    });
  }
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshRecords, 60);
  }
  function checkRow(text, checked, action) {
    const row = el("label", "ns-check-row"),
      label = el("span", "", text),
      input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => action(input));
    row.append(label, input);
    return row;
  }
  async function save(next) {
    if (busy) return false;
    busy = true;
    dialog.querySelectorAll("input").forEach((n) => (n.disabled = true));
    appDialog
      ?.querySelectorAll("input[type=checkbox]")
      .forEach((n) => (n.disabled = true));
    const hint = dialog.querySelector(".ns-save-status");
    hint.textContent = "正在保存…";
    try {
      info = await invoke("notification_settings", { settings: next });
      config = info.settings;
      hint.textContent = "已保存";
      if (appDialog?.open)
        appDialog.querySelector(".ns-save-status").textContent = "已保存";
      renderDevices();
      return true;
    } catch (e) {
      hint.textContent = `保存失败：${getErrorMessage(e)}`;
      if (appDialog?.open)
        appDialog.querySelector(".ns-save-status").textContent =
          hint.textContent;
      return false;
    } finally {
      busy = false;
      dialog.querySelectorAll("input").forEach((n) => (n.disabled = false));
      appDialog
        ?.querySelectorAll("input[type=checkbox]")
        .forEach((n) => (n.disabled = false));
    }
  }
  function updateSet(field, value, checked) {
    const values = new Set(config[field]);
    checked ? values.add(value) : values.delete(value);
    return { ...config, [field]: [...values] };
  }
  async function systemAction(action) {
    try {
      await invoke("notification_action", { action });
    } catch (e) {
      dialog.querySelector(".ns-save-status").textContent = getErrorMessage(e);
    }
  }
  async function chooseApps() {
    appDialog.querySelector(".ns-app-options").textContent = "正在读取应用…";
    appDialog.showModal();
    try {
      const result = await invoke("notification_action", { action: "apps" });
      const list = appDialog.querySelector(".ns-app-options");
      list.replaceChildren();
      if (!(result.apps || []).length) {
        list.append(el("p", "ns-hint", "未能读取应用列表。请在系统的 LQ Chat 应用权限中检查“读取已安装应用列表”（如果有此选项），授权后重新打开本页。"));
        return;
      }
      for (const app of result.apps || []) {
        const row = checkRow(
          `${app.name} · ${app.package}`,
          config.allowed_packages.includes(app.package),
          async (input) => {
            if (
              !(await save(
                updateSet("allowed_packages", app.package, input.checked),
              ))
            )
              input.checked = !input.checked;
            dialog.querySelector(".ns-app-count").textContent =
              `允许推送的应用 · 已选 ${config.allowed_packages.length}`;
          },
        );
        row.dataset.search = `${app.name} ${app.package}`.toLowerCase();
        list.append(row);
      }
    } catch (e) {
      appDialog.querySelector(".ns-app-options").textContent =
        getErrorMessage(e);
    }
  }
  function renderSettings() {
    const content = dialog.querySelector(".ns-settings-content");
    content.replaceChildren();
    if (android) {
      const heading = el("h3", "", "信息推送");
      content.append(
        heading,
        checkRow("信息推送总开关", config.push_enabled, async (input) => {
          if (!(await save({ ...config, push_enabled: input.checked })))
            input.checked = !input.checked;
        }),
      );
      content.append(el("h4", "", "推送目标设备（可多选）"));
      const choices = el("div", "ns-target-options");
      const ids = [
        ...new Set([...peers.map((p) => p.id), ...config.target_device_ids]),
      ].filter((id) => id !== localId);
      for (const id of ids) {
        const p = peerFor(id);
        choices.append(
          checkRow(
            `${nameFor(id)} · ${p && !p.is_offline ? "在线" : "离线"}`,
            config.target_device_ids.includes(id),
            async (input) => {
              if (
                !(await save(updateSet("target_device_ids", id, input.checked)))
              )
                input.checked = !input.checked;
            },
          ),
        );
      }
      if (!ids.length)
        choices.append(
          el("p", "ns-hint", "尚未发现其他设备。请先启动对方的 LanChat。"),
        );
      content.append(
        choices,
        button(
          `允许推送的应用 · 已选 ${config.allowed_packages.length}`,
          chooseApps,
          "ns-button ns-app-count",
        ),
      );
      content.append(
        button(`通知访问权限 · ${info.access ? "已授权" : "未授权"}`, () =>
          systemAction("access"),
        ),
      );
      content.append(
        button("发送测试通知", async (event) => {
          const b = event.currentTarget;
          b.disabled = true;
          dialog.querySelector(".ns-save-status").textContent =
            "正在发送，请在各目标推送详情查看结果…";
          try {
            await invoke("notification_test");
            dialog.querySelector(".ns-save-status").textContent =
              "本次尝试已结束，各设备结果请查看推送详情。";
            await refreshRecords();
          } catch (e) {
            dialog.querySelector(".ns-save-status").textContent =
              getErrorMessage(e);
          } finally {
            b.disabled = false;
          }
        }),
      );
    }
    content.append(
      el("h3", "", "信息接收"),
      checkRow(
        "允许接收其他设备的通知",
        config.receive_enabled,
        async (input) => {
          if (!(await save({ ...config, receive_enabled: input.checked })))
            input.checked = !input.checked;
        },
      ),
    );
    content.append(
      button(
        `系统通知设置${info.permission === "blocked" ? " · 已受阻" : ""}`,
        () => systemAction("permission"),
      ),
    );
    content.append(
      el(
        "p",
        "ns-hint",
        "双方需先手动启动 LanChat。在手机推送设置中勾选本机；目标离线时直接丢弃，不补发。",
      ),
    );
    content.append(
      el(
        "p",
        "ns-hint",
        "沿用局域网信任模型，请仅向自有可信设备推送。通知查看记录保留七天，不用于重试或补发。",
      ),
    );
  }
  async function openSettings() {
    if (!enabled) return;
    try {
      info = await invoke("notification_settings");
      config = info.settings;
      renderSettings();
      renderDevices();
      dialog.querySelector(".ns-save-status").textContent = "";
      if (!dialog.open) dialog.showModal();
    } catch (e) {
      dialog.querySelector(".ns-save-status").textContent =
        `读取设置失败：${getErrorMessage(e)}`;
      if (!dialog.open) dialog.showModal();
    }
  }
  async function init(options) {
    if (!window.__TAURI__ || enabled) return;
    try {
      info = await invoke("notification_settings");
    } catch (error) {
      console.warn("[NotificationSync] 初始化未完成", getErrorMessage(error));
      if (!document.getElementById("notification-init-retry")) {
        const retry = button("通知功能尚未就绪，点击重试", () => init(options));
        retry.id = "notification-init-retry";
        document.querySelector(".user-list-container")?.append(retry);
      }
      return;
    }
    document.getElementById("notification-init-retry")?.remove();
    if (!["android", "windows"].includes(info.platform)) return;
    enabled = true;
    android = info.platform === "android";
    config = info.settings;
    localId = await apiGetMyId();
    document.body.classList.add("notification-enabled");
    if (!android) document.body.classList.add("windows-app");
    const main = document.querySelector(".main-content"),
      sidebar = document.querySelector(".user-list-container"),
      chatList = document.getElementById("user-list");
    const chatGroup = el("details", "ns-chat-group");
    chatGroup.open = true;
    chatGroup.append(el("summary", "", "局域网聊天设备"));
    chatList.before(chatGroup);
    chatGroup.append(chatList);
    if (android) {
      const g = group("信息推送设备", true);
      pushList = g.list;
      chatGroup.after(g.box);
    }
    const incoming = group("信息接收设备", false);
    receiveList = incoming.list;
    sidebar.insertBefore(
      incoming.box,
      document.getElementById("android-listening"),
    );
    welcome = el("section", "ns-welcome");
    welcome.append(
      el("span", "ns-welcome-mark", "L"),
      el("p", "ns-eyebrow", "LQ CHAT · 局域网互联"),
      el("h2", "", "手机上的消息，在电脑上接收"),
      el("p", "ns-welcome-hint"),
      button("设置信息接收", openSettings),
    );
    main.append(welcome);
    panel = el("section", "ns-detail");
    panel.hidden = true;
    const head = el("header", "ns-detail-header"),
      titles = el("div");
    titles.append(el("h2", "ns-detail-title"), el("p", "ns-detail-status"));
    head.append(
      button("‹ 返回", close, "ns-text-button"),
      titles,
      button("设置", openSettings),
    );
    panel.append(
      head,
      el("div", "ns-cards"),
      button(
        "有新通知",
        () => {
          panel.querySelector(".ns-cards").scrollTop = 0;
          panel.querySelector(".ns-new").hidden = true;
        },
        "ns-new ns-button",
      ),
      el(
        "footer",
        "ns-footer",
        "通知查看记录保留七天 · 此视图不能发送聊天或文件",
      ),
    );
    panel.querySelector(".ns-new").hidden = true;
    main.append(panel);
    new ResizeObserver(() => {
      panel.querySelectorAll(".ns-card").forEach(card => {
        const body = card.querySelector(".ns-body");
        card.querySelector(".ns-more").hidden = !card.classList.contains("expanded") && body.scrollHeight <= body.clientHeight + 1;
      });
    }).observe(panel.querySelector(".ns-cards"));
    dialog = el("dialog", "ns-dialog");
    const dialogHead = el("header", "ns-dialog-header");
    dialogHead.append(
      el("h2", "", android ? "信息推送与接收" : "信息接收设置"),
      button("关闭", () => dialog.close(), "ns-text-button"),
    );
    dialog.append(
      dialogHead,
      el("div", "ns-settings-content"),
      el("p", "ns-save-status"),
    );
    dialog.querySelector(".ns-save-status").setAttribute("role", "status");
    document.body.append(dialog);
    appDialog = el("dialog", "ns-dialog");
    const appHead = el("header", "ns-dialog-header");
    appHead.append(
      el("h2", "", "允许推送的应用"),
      button("完成", () => appDialog.close(), "ns-text-button"),
    );
    const search = el("input", "ns-app-search");
    search.placeholder = "搜索应用";
    search.setAttribute("aria-label", "搜索应用");
    search.addEventListener("input", () => {
      appDialog
        .querySelectorAll("[data-search]")
        .forEach(
          (row) =>
            (row.hidden = !row.dataset.search.includes(
              search.value.toLowerCase(),
            )),
        );
    });
    appDialog.append(
      appHead,
      search,
      el("div", "ns-app-options"),
      el("p", "ns-save-status"),
    );
    document.body.append(appDialog);
    document
      .querySelector(
        "#settings-panel .settings-content, #settings-panel .panel-content",
      )
      ?.append(button("信息推送与接收", openSettings));
    if (!document.querySelector("#settings-panel .ns-button"))
      document
        .getElementById("settings-panel")
        ?.append(
          button(android ? "信息推送与接收" : "信息接收设置", openSettings),
        );
    window.addEventListener("popstate", () => {
      if (location.hash !== "#notifications") leave();
    });
    window.addEventListener("focus", () => {
      refreshSoon();
      if (dialog.open && !busy) openSettings();
    });
    await apiListen("notification-records-changed", refreshSoon);
    window.addEventListener("synced-notification-tapped", (event) =>
      handleSyncedActivation(event.detail),
    );
    await apiListen("synced-notification-tapped", (event) =>
      handleSyncedActivation(event.payload),
    );
    try {
      const pendingActivation = await invoke("notification_pending_activation");
      if (pendingActivation) await handleSyncedActivation(pendingActivation);
    } catch (_) {}
    await apiListen("core-state-changed", (event) => {
      refreshSoon();
    });
    peers = ((await apiGetPeers()) || []).filter((p) => p.id !== localId);
    await refreshRecords();
    renderDevices();
  }
  function onPeers(value) {
    if (!enabled) return;
    peers = value.filter((p) => p.id !== localId);
    renderDevices();
  }
    return { init, onPeers, leave, openSettings, open };
})();
