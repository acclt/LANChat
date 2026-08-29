# LANChat Android 后台与息屏接收开发方案

> 当前产品基线：正常存活期间保证后台/锁屏/息屏局域网通信；用户从最近任务划掉 LANChat 时，视为主动退出并彻底停止后台运行。

## 一、当前结论

LANChat 当前在 Tauri `setup` 中直接启动 UDP 监听、设备广播和 HTTP/WebSocket 服务，Android 原生层没有独立的 Foreground Service。网络任务依赖 Tauri Runtime，Activity/WebView 被销毁时，网络服务无法获得独立、稳定的 Android 后台生命周期。

现有实现还存在以下约束：

- Android Manifest 未声明后台接收 Service。
- 全局 `APP_HANDLE` 使用一次性 `OnceLock`，Activity 重建后可能继续引用旧界面。
- Android 消息通知由前端 JavaScript 触发，WebView 不运行时无法产生新消息通知。
- UDP 监听使用阻塞式 `UdpSocket.recv_from()`，尚无统一取消、启动握手和错误状态管理。
- HTTP Server 绑定和运行使用 `unwrap()`，无法向 Service 准确报告端口占用等启动错误。

正式方案采用：

> 同进程 Android Foreground Service + 独立 Rust CoreRuntime + CoreEventBus。

不实现系统杀进程后的自动恢复，也不实现最近任务划掉后的继续运行。

## 二、产品行为与范围

### 2.1 必须实现的行为

```text
前台打开 LANChat
→ 启动 Foreground Service 和唯一 CoreRuntime
→ 文字、单文件、多文件正常收发

按 Home / 切换到其他 App
→ Service 与 CoreRuntime 继续运行
→ 后台亮屏继续接收

锁屏 / 息屏
→ Service 与 CoreRuntime 继续运行
→ 在 Android 和厂商电量策略允许的范围内尽可能持续接收

Activity 被 Android 重建
→ UI 重新连接已有 CoreRuntime
→ 不创建第二套 UDP/HTTP 监听

从最近任务划掉 LANChat
→ 视为用户主动退出
→ 停止 CoreRuntime 和 Foreground Service
→ 释放端口、任务、MulticastLock 和 WakeLock
→ 移除常驻通知
```

### 2.2 当前明确不做

```text
系统意外杀死整个进程后的自动恢复
手机重启后的自动恢复
用户强制停止后的恢复
最近任务划掉后继续后台运行
WorkManager、Alarm、广播接收器或 Sticky Service 自动拉活
```

如果整个 LANChat 进程被系统终止，后台接收随之停止。等待用户重新打开 LANChat 后，才开始新的运行会话。

## 三、目标架构

```text
Android 系统
    │
    └── LanChatForegroundService（Android Core 生命周期唯一所有者）
            │
            ├── 常驻通知与服务状态
            ├── MulticastLock
            ├── 传输阶段短时 WakeLock
            ├── AndroidEventBridge
            └── JNI
                 │
                 ▼
          Rust CoreRuntime（进程级单例）
            ├── SQLite
            ├── PeerManager
            ├── UDP Discovery
            ├── HTTP/WebSocket Server
            ├── 消息与文件收发
            └── CoreEventBus
                 │
          ┌──────┴────────┐
          ▼               ▼
    Android 通知       Tauri UI
    后台可工作         只连接和订阅
```

Service 与 Activity 保持在同一进程，不配置 `android:process`。它们共享同一个 Rust 单例、SQLite Pool、PeerManager 和端口监听。

Android 侧不使用 `UiLease / ServiceLease` 引用计数模型：

- Service 是 CoreRuntime 的唯一生命周期所有者。
- Activity/UI 不拥有 CoreRuntime，不因 `onPause()`、`onStop()` 或普通 `onDestroy()` 停止 Core。
- Android UI 不直接创建第二套网络核心，只读取状态、调用业务能力和订阅事件。
- 桌面端继续由桌面应用生命周期持有 CoreRuntime。
- 每次用户重新打开已退出的 Android App，形成一个新的运行会话。

## 四、Android Foreground Service 设计

新增 `LanChatForegroundService.kt`，主要职责：

- 用户打开 LANChat 时，由可见 Activity 显式启动 Service。
- 启动后立即调用 `startForeground()`，显示“正在启动后台接收服务”。
- 通过 JNI 调用唯一的 Rust `CoreRuntime.start()`。
- Rust 完成数据库初始化、UDP 监听和 HTTP/WebSocket 端口绑定后，更新通知为“已准备好发送和接收消息与文件”。
- 订阅 AndroidEventBridge，将已落库的消息、文件完成事件转换为 Android 通知。
- 在 Wi-Fi 可用且本次会话运行期间管理 MulticastLock。
- 在实际消息或文件处理阶段管理带超时的短时 WakeLock。
- 最近任务被移除时随任务停止；正常回调路径执行幂等清理，进程被直接终止时由系统回收进程资源。
- 拒绝无有效用户会话、Rust 动态库未就绪或系统尝试重建产生的 Service-only 启动。
- 核心异常时进入 ERROR，不能继续显示正常运行状态。

### 4.1 Service 声明

项目当前 `compileSdk = 36`、`targetSdk = 36`、`minSdk = 24`。建议声明：

```xml
<service
    android:name=".LanChatForegroundService"
    android:exported="false"
    android:stopWithTask="true"
    android:foregroundServiceType="remoteMessaging|connectedDevice" />
```

`android:stopWithTask="true"` 是“划掉最近任务即主动退出”的系统级保证。任务被移除时，Android 先清除 started Service 状态，避免 Service 保留在重建队列中；随后无论系统调用 `onDestroy()` 还是直接结束进程，都不得自动恢复后台接收。

`onTaskRemoved()` 仅作为部分 OEM 行为的防御路径，不能作为唯一退出保证。正常收到 `onDestroy()` 时执行幂等 Core 清理；进程被系统直接终止时，由系统回收该进程持有的 Socket、线程和锁。

`onStartCommand()` 返回：

```kotlin
START_NOT_STICKY
```

禁止使用 `START_STICKY` 或 `START_REDELIVER_INTENT`。进程被系统终止后，不应自动重建 Service。

Service 的 `onCreate()` 不得调用任何 JNI 方法。`onStartCommand()` 只接受带随机会话令牌的显式启动、重试或停止 Action；空 Action、令牌无效、令牌过期或当前进程尚未由可见 Activity 加载 Rust 动态库时，必须先使会话失效并立即 `stopSelf()`，不得注册 EventBridge、启动 Core 或调用任何 native 方法。持久会话标记只用于拒绝非法启动，不得用于自动拉活。

### 4.2 启动和退出

启动流程：

```text
MainActivity 可见启动
→ 先成功调用 UI JNI，确认本进程 Rust 动态库已经加载
→ 生成并同步持久化新的随机会话令牌
→ 携带显式 Action 和令牌调用 startForegroundService()
→ Service 校验令牌与进程内 nativeReady 门禁
→ Service 立即显示 STARTING 常驻通知
→ 注册 AndroidEventBridge
→ nativeStartCore(applicationInfo.dataDir)
→ Core 启动成功后进入 RUNNING
```

最近任务划掉后的退出流程：

```text
Android 根据 stopWithTask=true 停止 started Service
├── 正常回调 onDestroy()
│   → 同步使会话令牌失效
│   → 异步调用幂等 nativeStopCore()
│   → 注销 AndroidEventBridge
│   → 释放通知、WakeLock 和 MulticastLock
│   → 停止 Service
└── 系统直接终止进程
    → 系统回收 Socket、线程和锁
    → started Service 状态已经清除，不得重建
```

`onTaskRemoved()` 保留同一幂等清理入口作为 OEM 防御路径。所有退出入口必须先使会话令牌失效；不得在 Android 主线程同步等待 Rust 网络任务。

如果退出过程中进程被系统直接终止，系统会回收进程持有的 Socket、线程和锁；应用不安排任何自动重启。

### 4.3 已验证的退出边界

MuMu 12 已验证：Clear All 后连续 35 秒无应用 PID、无 `LanChatForegroundService`、无 UDP/TCP 8888、无常驻通知 4100，且 `UnsatisfiedLinkError`、`FATAL EXCEPTION` 和 LANChat Service 重建次数均为 0。再次由用户显式打开后，只建立一套 Service、Core 和端口，并可在 Home 后继续接收消息。该结果关闭“划掉后 Service 复活并在 JNI 未加载时崩溃”的 P0；真机息屏、Doze、厂商 ROM 和真实 Wi-Fi 组播仍按后续验收矩阵执行。

## 五、Rust CoreRuntime

建议新增：

```text
src-tauri/src/core_runtime.rs
src-tauri/src/core_events.rs
src-tauri/src/android_service.rs
```

`CoreRuntime` 持有：

- 独立 Tokio 多线程 Runtime。
- SQLite Pool。
- PeerManager。
- UDP Listener、UDP Announcer、HTTP/WebSocket Server 任务句柄。
- CancellationToken。
- CoreEvent 广播通道。
- 当前状态、启动代次、端口和错误信息。

### 5.1 状态机

```text
STOPPED
   ↓ 显式启动
STARTING
   ├── 全部成功 → RUNNING
   └── 任一失败 → 回滚全部资源 → ERROR

RUNNING
   ↓ 划掉任务 / 主动退出
STOPPING
   ↓ 清理完成
STOPPED

ERROR
   ↓ 用户手动重试或重新打开 App
STARTING
```

ERROR 状态不进行定时自动重试。允许用户明确点击重试，但必须继续复用同一个幂等启动入口。

每个状态至少包含：

```text
state
generation
port
started_at
last_error_code
last_error_message
```

### 5.2 启动要求

- CoreRuntime 在进程内只能有一个。
- `start()` 必须幂等；并发调用只能产生一次真实启动。
- 数据库、UDP Listener、UDP Announcer、HTTP/WebSocket 全部成功后才能进入 `RUNNING`。
- 启动采用事务化语义：任何一步失败，必须取消并等待已启动任务，关闭已绑定 Socket 和数据库资源，不允许保留半运行状态。
- 数据库失败、端口占用、任务 panic 或异常退出必须产生明确错误状态。
- SQLite 使用现有 Android `applicationInfo.dataDir`，不得迁移或复制现有数据库。
- `web_server::start_server()` 返回 `Result`，支持 graceful shutdown，移除启动路径中的强制 `unwrap()`。
- 将阻塞式 `UdpSocket.recv_from()` 改为 Tokio 异步 UDP 或可取消的专用阻塞线程。

### 5.3 停止要求

`stop()` 必须幂等并完成以下顺序：

1. 原子切换到 `STOPPING`，拒绝新业务和重复停止。
2. 触发统一取消令牌。
3. 停止 UDP 接收、设备广播、HTTP/WebSocket Accept Loop 和文件传输任务。
4. 关闭监听 Socket，等待任务在限定时间内退出。
5. 刷新或回滚未完成数据库操作并释放 Pool。
6. 清理事件订阅、PeerManager 和运行句柄。
7. 确认端口可再次绑定后进入 `STOPPED`。

若个别任务超过停止时限，应记录明确错误并执行强制中止兜底；不得留下假 `STOPPED` 状态或残留端口。

## 六、CoreEventBus、JNI 与 AndroidEventBridge

网络层不再直接持有旧 `AppHandle`，统一发布 CoreEvent：

```text
CoreStateChanged
PeerDiscovered
MessageReceived
FileOfferReceived
FileTransferStarted
FileTransferProgress
FileTransferCompleted
MessagesResent
CoreError
```

事件顺序必须满足：

```text
接收并校验网络数据
→ 数据库事务提交成功
→ 发布 CoreEvent
→ AndroidEventBridge 生成通知
→ UI 刷新数据库
```

数据库提交失败时不得发送“消息已收到”或“文件已完成”通知，以免通知与聊天记录不一致。

Service 与 Rust Core 位于同一进程，JNI 接口建议包括：

```text
nativeStartCore(appDataDir)
nativeStopCore()
nativeGetCoreStatus()
nativeRegisterServiceEventSink()
nativeUnregisterServiceEventSink()
nativeSetUiVisibility(visible)
```

AndroidEventBridge 要求：

- Service 创建后注册，退出前注销。
- 重复注册、注销必须安全，不能产生重复通知订阅。
- JNI 回调不得阻塞 Rust 网络线程或 Android 主线程。
- Activity 每次创建时只订阅 UI 事件；Activity 销毁后取消本次 UI 订阅。
- Activity 重建时重新连接现有 Core，不能重新绑定 UDP/HTTP。
- 现有 `APP_HANDLE: OnceLock<AppHandle>` 应移除，或改成可替换、可清理的当前 UI 句柄。

Service 必须能够在 Activity 已进入后台或普通重建期间继续调用既有 Rust Core，但不需要支持进程被杀后的独立恢复启动。

## 七、通知设计

至少创建两个通知渠道：

| 渠道 | 用途 | 行为 |
|---|---|---|
| `lanchat_background_service` | Foreground Service | 低重要性、无声音、持续显示 |
| `lanchat_messages` | 新消息、文件完成、服务错误 | 正常提醒 |

通知要求：

- 常驻通知使用固定且保留的 Notification ID。
- 消息通知使用独立 ID 区间，不能覆盖常驻通知。
- STARTING、RUNNING、ERROR 文案与真实 Core 状态一致。
- 点击常驻通知打开 LANChat。
- 点击消息通知携带 `peer_id`，UI 创建并刷新数据库后进入对应聊天。
- Android 新消息和文件完成通知从 JavaScript 迁移到 Service/Core 事件层。
- Android 前台可见时不重复弹系统消息通知；桌面通知逻辑保持不变。
- 划掉最近任务并完成退出后，常驻通知必须消失。
- Service 异常退出时不能留下“正在运行”的假通知。

建议文案：

```text
正在启动后台接收服务
已准备好发送和接收消息与文件
后台接收发生异常，点击查看
```

## 八、MulticastLock、WakeLock 与息屏策略

### 8.1 MulticastLock

LANChat 使用 `224.0.0.167` 组播发现设备。本次运行会话处于 RUNNING 且 Wi-Fi 可用时，由 Service 持有 `MulticastLock`。

- 防止重复 acquire。
- Wi-Fi 断开、Core 停止、最近任务划掉或 Service 销毁时立即释放。
- acquire/release 记录状态和日志。
- 不把 MulticastLock 当作绕过 Doze 的能力。

### 8.2 WakeLock

不永久持有 CPU WakeLock。

只在实际处理期间短时持有带 timeout 的 Partial WakeLock，例如：

```text
网络事件已交付 / 文件传输开始
→ 获取短时 WakeLock
→ 校验、入库、接收或写盘
→ finally 中立即释放
```

等待 Socket 数据时不永久持有 WakeLock。所有异常、取消和超时路径都必须释放。

### 8.3 WifiLock

第一版不永久持有 WifiLock。只有真机测试证明特定设备在活动文件传输时 Wi-Fi 被挂起，才考虑在传输期间短时启用，并记录耗电数据。

### 8.4 Doze 与厂商限制

Foreground Service 和 MulticastLock 不能完全绕过深度 Doze：

- 提供电池优化状态和“前往设置为不受限制”入口。
- 高可靠息屏接收场景提示用户把 LANChat 设置为“不受限制”。
- 不使用隐藏通知、频繁 Alarm、WorkManager 循环、自启动广播或拉起 Activity。
- 不承诺所有 ROM 在默认电池限制下百分之百实时接收。
- 小米、vivo、OPPO、华为等厂商策略必须标记真机实测结果。

## 九、设置与产品行为

每次用户从桌面显式打开 LANChat 时自动启动本次后台接收会话，确保按 Home 后具备后台接收能力。

Android 设置页至少展示：

```text
后台接收状态
● 正在运行
○ 已停止
△ 启动失败

通知权限状态
电池优化状态
[ 前往设置为不受限制 ]
[ 停止后台接收并退出 ]
```

“停止后台接收并退出”与最近任务划掉执行同一幂等清理入口。再次显式打开 App 时允许开始新的运行会话。

不得保存或调度用于进程被杀后自动恢复 Service 的运行请求。普通业务设置仍可保存在 SQLite 或 SharedPreferences，但不能被后台组件用于自动拉活。

设置接口建议：

```text
get_background_receive_state()
stop_background_receive_and_exit()
retry_background_service()
get_battery_optimization_state()
open_battery_optimization_settings()
```

## 十、权限与 Android 版本

新增并保留必要权限：

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

现有权限不得在改造中误删：

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
```

`remoteMessaging` 对应设备间消息，`connectedDevice` 覆盖局域网设备交互。不要使用存在后台累计运行时限的 `dataSync` 类型。实现时必须校验 targetSdk 36 下各 Foreground Service 类型的权限前置条件。

当前 targetSdk 36 不提前添加 `ACCESS_LOCAL_NETWORK`。Android 17、targetSdk 37 以后，本地 TCP、UDP、广播和组播权限发生变化时，再增加运行时权限申请；当前代码预留错误状态即可。

## 十一、主要文件改动

| 文件 | 改动 |
|---|---|
| `src-tauri/src/lib.rs` | Android 不再直接启动三组网络任务；桌面端连接统一 CoreRuntime |
| `src-tauri/src/core_runtime.rs` | 新增进程级网络核心、事务化启动和幂等停止 |
| `src-tauri/src/core_events.rs` | 新增统一事件模型 |
| `src-tauri/src/android_service.rs` | 新增 Service JNI 和 AndroidEventBridge 入口 |
| `src-tauri/src/network/discovery.rs` | 异步化、可取消、返回启动错误 |
| `src-tauri/src/web_server.rs` | 返回 Result、支持优雅停止、移除启动 unwrap |
| `src-tauri/src/network/messaging.rs` | AppHandle 改为 CoreEventBus；提交数据库后发事件 |
| `src-tauri/src/db.rs` | 支持按 Android 数据目录初始化并共享 Pool |
| `src-tauri/src/commands.rs` | 新增状态、退出、手动重试和电池设置命令 |
| `src-tauri/Cargo.toml` | 增加取消控制等必要依赖 |
| `LanChatForegroundService.kt` | Service、通知、锁、JNI 回调、会话令牌门禁和幂等清理 |
| `MainActivity.kt` | 可见 UI 签发运行会话、显式启动 Service、UI 重连和通知跳转 |
| `AndroidManifest.xml` | 权限、Service 类型、`stopWithTask=true` |
| `build.gradle.kts` | 增加 AndroidX Core 等明确依赖 |
| `src/index.html` | 新增后台状态和电池设置项 |
| `src/js/ui.js`、`api.js`、`app.js` | 状态展示、控制和 Android 通知去重 |
| Android/Rust 测试目录 | 生命周期、重复启动、端口和退出测试 |
| `README.md`、`README_CN.md` | 使用方法、退出语义、限制和电池设置说明 |

## 十二、分阶段开发

### 阶段一：核心生命周期重构

- 建立 CoreRuntime 和 CoreEventBus。
- 实现单例、幂等 start/stop 和状态代次。
- 实现 UDP/HTTP 预绑定、统一取消和事务化启动回滚。
- 网络层移除对旧 AppHandle 的直接依赖。
- Android UI 只连接现有 Core；桌面端行为保持不变。
- 验证文字、单文件、多文件和离线补发无回归。

### 阶段二：Foreground Service 与事件桥

- 添加 Foreground Service 和常驻通知。
- 使用 `START_NOT_STICKY`。
- 完成 Service 与 Rust JNI、AndroidEventBridge 连接。
- 确保数据库提交成功后才发送通知事件。
- Android 普通通知迁移到 Service/Core 事件层。
- 验证后台亮屏 5 至 30 分钟仍可收发。

### 阶段三：息屏接收

- 加入 MulticastLock。
- 文件和消息处理阶段加入有超时的短时 WakeLock。
- 增加电池优化状态和设置入口。
- 分别验证已知 IP 直连与新设备组播发现。
- 分别验证默认电池优化、不受限制和强制 Doze。

### 阶段四：主动退出与稳定性

- 使用 `stopWithTask=true` 保证划掉任务时清除 started Service 状态，以 `onDestroy()` 执行正常幂等清理，并保留 `onTaskRemoved()` 作为 OEM 防御路径。
- 增加显式会话令牌和进程内 JNI 就绪门禁，拒绝 Service-only 重建且不调用 native。
- 验证最近任务划掉后 Service、Core、端口、锁和通知全部停止。
- 验证系统杀进程、重启手机和强制停止后不会自动恢复。
- 测试 Activity 重建、服务重复启动、端口占用和启动回滚。
- 连续运行约 2 小时，检查内存、CPU、线程、任务和锁。
- 完善错误通知、日志和文档。

实施期间可以分阶段创建本地提交，但未经用户明确授权不得推送远程仓库。

## 十三、验证方案

### 13.1 功能矩阵

至少覆盖：

```text
Windows → Android：文字、单文件、多文件
Android → Windows：文字、单文件、多文件
Android → Android：文字、单文件、多文件
```

同时覆盖图片、手动接收、自动接收和离线补发，重点防止重复消息、重复文件、文件漏发、只发送第一个文件、进度卡住和聊天记录状态错误。

### 13.2 生命周期场景

- Android 前台运行。
- 按 Home 或切换其他 App 后，后台亮屏 5 分钟、30 分钟。
- 锁屏/息屏 5 分钟、30 分钟、2 小时。
- Activity 配置变化、系统销毁 Activity 后重建。
- 点击常驻通知恢复 UI。
- 点击消息通知进入正确聊天。
- 最近任务划掉后主动退出。
- 系统终止整个进程后不自动恢复。
- 手机重启后不自动恢复。
- 用户强制停止后不自动恢复。

### 13.3 息屏网络矩阵

每个时间档分别测试：

| 场景 | 默认电池优化 | 不受限制 | 强制 Doze |
|---|---:|---:|---:|
| 已知设备地址直接发送文字 | 记录 | 必须验证 | 记录系统限制 |
| 已知设备地址直接发送文件 | 记录 | 必须验证 | 记录系统限制 |
| 新设备通过组播被发现 | 记录 | 必须验证 | 记录系统限制 |
| 已开始的文件传输后息屏 | 记录 | 必须验证 | 记录系统限制 |

“记录”表示提供真机结果和日志，不把 Android/厂商节电限制导致的延迟虚报为应用成功或失败。“必须验证”仍须以真机结果为准。

### 13.4 故障与回滚

- UDP 端口被占用。
- HTTP 端口被占用。
- 数据库打开失败。
- DB 成功、UDP 成功、HTTP 失败时，确认前两项全部回滚。
- Wi-Fi 断开与恢复。
- 网络从 Wi-Fi 切换到其他网络。
- 通知权限拒绝。
- Rust 网络任务异常退出。
- 重复调用启动和停止。
- STOPPING 期间用户立即重新打开 App。

### 13.5 资源检查

- CoreRuntime 进程内始终只有一个。
- 不出现重复 Service、端口绑定、消息、文件或通知。
- 划掉任务后常驻通知消失。
- UDP/HTTP 端口可以被重新绑定。
- 无永久 WakeLock，所有 timeout 和异常路径释放。
- MulticastLock 在 Wi-Fi 断开或 Service 停止后释放。
- 连续运行约 2 小时无明显内存持续增长。
- CPU 空闲时保持低占用，线程和异步任务数量基本稳定。
- 后台广播频率不会造成异常耗电或网络风暴。

## 十四、最终验收门槛

必须满足：

- 前台文字、单文件和多文件双向收发无回归。
- 按 Home、切换 App 和普通 Activity 重建后，Core 继续运行且不重复监听。
- 锁屏和息屏结果符合测试矩阵，不夸大 Doze 或厂商限制下的可靠性。
- UI 重新打开不白屏，不创建第二个 Core 或 Service。
- 新消息和文件完成通知不依赖 WebView JavaScript。
- 通知事件只在数据库提交成功后产生。
- STARTING、RUNNING、ERROR 与真实 UDP/HTTP 状态一致。
- 任一步启动失败都完整回滚，不保留半运行 Core。
- 最近任务划掉后，Service 停止、Core 停止、常驻通知消失、端口和所有锁释放。
- 系统杀进程、手机重启和用户强制停止后不自行复活。
- 连续运行约 2 小时无明显资源泄漏或重复任务。
- 无法自动完成的真机、长时间息屏和厂商 ROM 测试明确标为“待真机验证”，不得虚报通过。

最终验收链路：

```text
启动 LANChat
→ 前台文字/单文件/多文件收发正常
→ 按 Home，后台亮屏仍能接收
→ 锁屏，仍能接收
→ 息屏 5 / 30 / 120 分钟，完成分级真机测试
→ 重新打开 UI，无重复消息、文件、端口或通知
→ 再次验证文字/单文件/多文件
→ 从最近任务划掉 LANChat
→ Service 与 Core 停止
→ 常驻通知消失
→ UDP/HTTP、所有任务和锁释放
→ 不发生自动恢复
```

## 十五、当前基线

```text
分支：main
提交：cd3a3011f6662c7d7133cab6a3dbb09d51a7218e
远程：origin/main
```
