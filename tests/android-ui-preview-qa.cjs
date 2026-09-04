const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const pages = await (await fetch("http://127.0.0.1:9337/json/list")).json();
  const page = pages.find((item) => item.url.includes("android-preview=1"));
  assert(page, "Android preview page not found");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let requestId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails) reject(message.error || message.result.exceptionDetails);
    else resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  };
  const capture = async (name) => {
    if (!process.env.QA_CAPTURE_DIR) return;
    const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.mkdirSync(process.env.QA_CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.QA_CAPTURE_DIR, `${name}.png`), Buffer.from(result.data, "base64"));
  };

  await send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const home = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.android-home-card')].map(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    return { innerWidth, scrollWidth: document.documentElement.scrollWidth, cards };
  })()`);
  console.log("home", JSON.stringify(home));
  assert.equal(home.scrollWidth, home.innerWidth, "Home page has horizontal overflow");
  assert(home.cards.every((card) => card.left >= 0 && card.right <= home.innerWidth), "Home card is clipped");
  await capture("android-home");

  const pushSources = await evaluate(`(async () => {
    document.getElementById('android-receive-sources-btn').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const panel = document.getElementById('android-push-sources-panel');
    const names = [...panel.querySelectorAll('.ns-name')].map(node => node.textContent.trim());
    return { visible: panel.style.display !== 'none', names };
  })()`);
  assert(pushSources.visible, "Push-source page did not open");
  assert.deepEqual(pushSources.names, ['IQOO'], "Push-source page must show only devices targeting this device");
  await capture("android-push-sources");
  await evaluate(`(async () => {
    document.getElementById('android-push-sources-back-btn').click();
    await new Promise(resolve => setTimeout(resolve, 80));
  })()`);

  const settings = await evaluate(`(async () => {
    document.getElementById('android-settings-btn').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const panel = document.getElementById('settings-panel');
    const targets = [...panel.querySelectorAll('.ns-target-options input[type=checkbox]')];
    const pushToggle = panel.querySelector('.ns-push-panel > .ns-check-row input[type=checkbox]');
    pushToggle.checked = true;
    pushToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    for (const input of targets.slice(0, 2)) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    panel.querySelector('.ns-test-button').click();
    await new Promise(resolve => setTimeout(resolve, 120));
    return {
      visible: getComputedStyle(panel).display !== 'none',
      targetCount: targets.length,
      selectedCount: targets.filter(input => input.checked).length,
      hasReceiveMenu: [...panel.querySelectorAll('*')].some(node => node.textContent?.trim() === '信息接收'),
      permissionEntry: !!document.getElementById('android-permissions-btn'),
      testStatus: panel.querySelector('.android-notification-settings .ns-save-status')?.textContent || ''
    };
  })()`);
  assert(settings.visible, "Settings page did not open");
  assert(settings.targetCount >= 2, "Push targets were not rendered");
  assert(settings.selectedCount >= 2, "Push targets are not independently selectable");
  assert.equal(settings.hasReceiveMenu, false, "Unexpected receive settings menu");
  assert(settings.permissionEntry, "Permission entry is missing");
  assert.match(settings.testStatus, /测试通知已发送到 2 台设备/, "Test notification feedback is missing");
  await capture("android-settings");

  const appPicker = await evaluate(`(async () => {
    document.querySelector('.ns-app-picker-row').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const panel = document.getElementById('android-push-apps-panel');
    const rows = [...panel.querySelectorAll('.android-push-app-row')];
    rows.forEach(row => row.querySelector('input').click());
    const selectedBeforeSave = rows.filter(row => row.querySelector('input').checked).length;
    const iconCount = rows.filter(row => row.querySelector('img')).length;
    return {
      rowCount: rows.length,
      selectedBeforeSave,
      iconCount,
      visible: panel.classList.contains('is-open')
    };
  })()`);
  assert.equal(appPicker.rowCount, 2, "Push-app picker did not render apps");
  assert.equal(appPicker.selectedBeforeSave, 2, "Push-app picker does not support multi-select");
  assert.equal(appPicker.iconCount, 1, "Push-app picker did not render an available app icon");
  assert(appPicker.visible, "Push-app picker did not open");
  const appSearch = await evaluate(`(() => {
    const search = document.getElementById('android-push-apps-search');
    const all = document.getElementById('android-push-apps-select-all');
    const query = (value) => { search.value = value; search.dispatchEvent(new Event('input')); };
    const checked = () => document.querySelectorAll('.android-push-app-row input:checked').length;
    const initiallyAll = all.checked;
    query('  短信  ');
    const filteredCount = document.querySelectorAll('.android-push-app-row').length;
    all.click();
    query('');
    const preservedOther = checked() === 1 && all.indeterminate && !all.checked;
    query('不存在的应用');
    const noMatches = all.disabled && !all.checked && !all.indeterminate && !document.getElementById('android-push-apps-empty').hidden;
    query('短信');
    all.click();
    query('');
    const restoredAll = all.checked && checked() === 2;
    all.click();
    const clearedAll = checked() === 0;
    all.click();
    return { initiallyAll, filteredCount, preservedOther, noMatches, restoredAll, clearedAll, finalCount: checked() };
  })()`);
  assert.deepEqual(appSearch, { initiallyAll: true, filteredCount: 1, preservedOther: true, noMatches: true, restoredAll: true, clearedAll: true, finalCount: 2 });
  await capture("android-push-apps");
  const appPickerSaved = await evaluate(`(async () => {
    const panel = document.getElementById('android-push-apps-panel');
    document.getElementById('android-push-apps-save-btn').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    return {
      closed: !panel.classList.contains('is-open'),
      summary: document.querySelector('.ns-app-picker-summary')?.textContent || ''
    };
  })()`);
  assert(appPickerSaved.closed, "Push-app picker did not close after saving");
  assert.match(appPickerSaved.summary, /已选 2 个/, "Push-app selection summary was not updated");
  const reopenedApps = await evaluate(`(async () => {
    document.querySelector('.ns-app-picker-row').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = {
      selected: document.querySelectorAll('.android-push-app-row input:checked').length,
      query: document.getElementById('android-push-apps-search').value,
      allChecked: document.getElementById('android-push-apps-select-all').checked
    };
    document.getElementById('android-push-apps-select-all').click();
    document.getElementById('android-push-apps-back-btn').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    document.querySelector('.ns-app-picker-row').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    result.cancelPreserved = document.querySelectorAll('.android-push-app-row input:checked').length === 2;
    document.getElementById('android-push-apps-back-btn').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    return result;
  })()`);
  assert.deepEqual(reopenedApps, { selected: 2, query: '', allChecked: true, cancelPreserved: true });

  const permissions = await evaluate(`(async () => {
    document.getElementById('android-permissions-btn').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const panel = document.getElementById('permissions-panel');
    const back = document.getElementById('android-permissions-back-btn').getBoundingClientRect();
    const header = panel.querySelector('.android-page-bar').getBoundingClientRect();
    return {
      visible: panel.classList.contains('is-open') && getComputedStyle(panel).display !== 'none',
      autoDownload: !!document.getElementById('auto-download-toggle'),
      notification: !!document.getElementById('notification-toggle'),
      background: !!document.getElementById('background-receive-status'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      scrollTop: panel.scrollTop,
      back: { top: back.top, bottom: back.bottom, left: back.left, right: back.right },
      header: { top: header.top, bottom: header.bottom }
    };
  })()`);
  assert(permissions.visible, "Permission page did not open");
  assert(permissions.autoDownload && permissions.notification && permissions.background, "Permission controls are incomplete");
  assert.equal(permissions.scrollWidth, permissions.innerWidth, "Permission page has horizontal overflow");
  await capture("android-permissions");
  const saved = await evaluate(`(async () => {
    const auto = document.getElementById('auto-download-toggle');
    auto.checked = !auto.checked;
    document.getElementById('save-permissions-btn').click();
    await new Promise(resolve => setTimeout(resolve, 800));
    return !document.getElementById('permissions-panel').classList.contains('is-open');
  })()`);
  assert(saved, "Saving permissions did not return to settings");
  socket.close();
  console.log(JSON.stringify({ home, pushSources, settings, appPicker, appSearch, appPickerSaved, permissions }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
