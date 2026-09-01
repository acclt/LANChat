# LanChat Android 运行期间定向通知同步升级方案

- 文档版本：3.2（实施前约束收紧）
- 整理日期：2026-08-31
- 状态：首版范围冻结；本文为实施依据，不代表功能已经实现或验收通过
- 适用场景：两个自有 Android 设备、固定可信 LAN、两端同步升级
- 核心原则：保留当前已验证的后台生命周期，只增加 LanChat 运行期间的定向通知同步

## 1. 本次升级目标

用户手动启动 LanChat 后，继续沿用现有前台、Home 后台、锁屏和息屏运行方式。在这段有效运行会话中，将允许同步的 App 通知发送给用户选择的一个设备，由对方显示系统通知。

> 首版范围：NotificationListenerService + App 允许列表 + 单一转发对象选择 + notification WebSocket 消息 + B 端系统通知、简单内存去重和防回环。目标不可达时直接丢弃，不排队、不重试、不补发。

本次不要求开机自启，不要求划掉 UI 后继续运行，也不增加系统回收后的自动恢复。此前同名文档中的后台恢复目标、设置项、文件改造和五阶段计划整体作废，以本次修订为准。

通知同步不依赖互联网、企业微信、Webhook、云推送或第三方服务器。

## 2. 实施基线与冻结边界

### 2.1 文档目录与后台代码基线

前轮只读审计发现，当前文档目录与已实现后台能力的代码位于不同工作区：

| 项目 | 前轮审计时状态 |
| --- | --- |
| 文档目录 | D:\SoftwareFree\LANChat |
| 文档目录分支 | main，审计提交 cd3a301；该提交尚未包含完整后台架构 |
| 实际后台工作区 | D:\SoftwareFree\LANChat-android-file-actions |
| 实际后台分支 | codex/android-background-receiving |
| 后台分支审计 HEAD | eeb4d06 |
| 未提交修改 | 审计时存在，包括 Android 0.19 配置；实施前核对并保留 |

实施前确认源码、现有改动和测试 APK 的对应关系，不在旧 main 上重新实现后台架构，不覆盖用户已有修改。上述记录来自前轮审计，不代表本次重新验证了 APK。

### 2.2 当前架构与本版使用方式

| 组件 | 当前事实 | 本次处理 |
| --- | --- | --- |
| LanChatForegroundService | 与 Activity 同进程，拥有 Core 生命周期、常驻通知及锁 | 仅增加通知事件处理，保留生命周期 |
| CoreRuntime | 进程级单例，管理现有网络任务和资源 | 复用，不改变创建、启动和停止语义 |
| UI | 手动启动现有会话，重建时复用 Core 资源 | 保留 |
| Discovery | 现有 UDP 组播、广播与自定义地址发现 | 保留 |
| PeerManager | 保存设备 ID、当前地址和在线信息 | 用于选择及查找唯一目标 |
| WebSocket | 小消息通常连接现有 /ws，发送后关闭 | 复用短连接模式，新增 notification 分支 |
| 文件 | 控制消息走 WebSocket，正文走 HTTP 分块上传 | 不改核心、协议或补发 |
| CoreEventBus | 现有 Service 和 UI 事件桥 | 复用，增加专用通知事件 |
| 系统重建策略 | 当前 START_NOT_STICKY，拒绝无有效会话的独立 Service 启动 | 保持原样 |
| 划掉任务策略 | 当前 stopWithTask=true，划掉即停止后台 | 保持原样 |
| Android 配置 | minSdk 24、targetSdk 36，已有 FGS 类型及权限 | 保持原样，只补通知监听所需声明 |

当前没有常驻 peer Connection Manager，也没有聊天与文件共享的 FILE_DATA 帧队列。复用现有通路不等于复用一条长期存在的 TCP 连接；不得因此增加常驻连接体系。

### 2.3 冻结能力

以下能力必须保持：

- 前台、Home 后台、锁屏、息屏接收消息与文件。
- UI 重建不重复监听，不重复创建 Core。
- 多文件传输、文件保存和现有消息/文件补发。
- 当前 WakeLock、MulticastLock 的取得、刷新和释放方式。
- 当前划掉退出、显式退出、系统回收及非法启动处理。
- 当前停止时任务、端口、锁和资源释放检查。

不修改 CoreRuntime 生命周期、Discovery、文件传输核心、UI 重建机制或锁函数。不增加冷启动应用上下文桥，不处理无 Activity 的首次原生初始化，不修改现有 SAF 文件路径。

## 3. 运行条件与总体链路

### 3.1 “LanChat 正在运行”的含义

本版要求用户已手动启动现有运行会话，原生环境已经由原有启动链路初始化，现有 Core 处于 RUNNING。仅仅存在 App 进程，或系统单独绑定了通知监听器，不代表条件成立。

NotificationListenerService 可能被系统单独创建。此时必须：

- 只读取 LanChatForegroundService 在当前 JVM 进程内维护的只读会话/原生就绪状态，判断是否可以工作。
- 原生库未就绪时不调用 JNI，包括不能先调用 native 状态查询再判断是否就绪。
- LanChat 未运行或正在停止时直接忽略通知。
- 不加载原生库来启动新会话，不启动 Activity、Foreground Service、Core 或网络监听。
- 不保存通知等待用户打开 LanChat。

运行门禁必须是 Kotlin/Service 本地检查，不得通过 JNI 查询 CoreRuntime 来判断 JNI 是否可用，不得实现 NLS → nativeIsCoreRunning() 这样的前置探测。读取本地状态本身也不得触发原生库加载。

必要时只暴露只读状态快照：进程初始为未就绪，在原有启动成功结果、核心状态事件和退出处理中更新镜像。它不持久化、不改变已有启动停止流程，也不是第二套生命周期管理器。状态未知、未运行或正在停止时均忽略通知。

### 3.2 目标链路

~~~text
用户手动启动 LanChat
→ 沿用当前已经验证的后台生命周期
→ 前台 / Home 后台 / 锁屏 / 息屏继续正常

A 收到系统通知
→ NotificationListenerService
→ Kotlin/Service 本地运行门禁（不调用 JNI）
→ 原生持久设置中的同步开关、App 允许列表、自身包过滤
→ 从原生持久设置读取单一 target_device_id
→ 从 PeerManager 取当前在线信息和地址
   ├─ 未选择 / 不存在 / 离线：丢弃
   └─ 在线：现有 /ws 一次定向发送
             ├─ 连接失败 / 超时 / B 拒绝：丢弃
             └─ B 校验并通过现有事件桥调用 NotificationManager
~~~

所有组件继续同进程。NotificationListenerService 不拥有 Core、Discovery 或 Socket，不建立第二个网络 Service，不订阅第二套后台接收事件。

### 3.3 不改变原有生命周期

| 场景 | 本版行为 |
| --- | --- |
| 用户手动启动 | 沿用原入口，当前会话就绪后允许同步 |
| 前台、Home 后台、锁屏、息屏 | 在现有 Service/Core 正常运行期间同步 |
| UI 重建 | 复用现有资源与事件桥 |
| 划掉最近任务或显式退出 | 按原有逻辑停止，通知功能不能阻止退出或重新拉起 |
| App 进程被回收、手机重启 | 不增加自动启动或自动恢复 |
| 系统单独绑定通知监听器 | LanChat 未运行则忽略通知 |
| 监听器重新绑定 | 仅在现有运行条件满足时恢复采集，不重放历史通知 |

## 4. 设置页与单一转发对象

首版只新增四类通知设置：

~~~text
通知同步              关

转发对象
Android B             已选择

允许同步的应用
✓ 微信
✓ 短信
□ 支付宝

通知访问权限          已授权 / 未授权
~~~

示例勾选表示用户配置后的效果。首次使用时通知同步关闭、目标未选择、允许列表为空。已有后台状态、电池优化引导、普通通知权限提示及停止按钮保留，不新增后台运行策略开关或复杂诊断面板。

通知配置统一由 NotificationSyncSettings.kt 管理，首版使用 Android SharedPreferences 持久保存同步开关、允许 App 列表和 target_device_id，作为这些配置的唯一来源。NLS 必须能直接读取，不依赖 Rust、JNI、WebView 或 UI 当前是否存在。

UI 修改设置时通过现有界面桥接写入上述原生存储，不能只更新 JavaScript 内存、localStorage 或 Rust 数据库。通过本地运行门禁后，NLS 再把本次发送所需的配置快照传给 Rust；Rust 不维护另一份持久通知设置。运行状态检查和通知设置读取均不得要求先初始化原生库。

目标选择规则：

- 从现有 PeerManager 设备列表选择一个目标，不支持多选，不允许选择本机。
- 保存 target_device_id，不固定保存 IP。
- 每次发送从 PeerManager 获取目标当前地址和在线状态。
- 未选择、设备不存在或目标不可达时丢弃，不改投其他设备。
- 目标暂时离线时保留用户选择，不缓存通知。
- 目标切换或同步关闭后，不再为旧配置启动新发送；已发出的数据无法撤回。

允许应用列表只做白名单，默认全关。应包含用户需要的系统短信 App，不能直接照用会过滤系统应用的 APK 分享选择器。不增加黑名单、关键词规则或多套过滤策略。

## 5. 通知采集与协议

### 5.1 NotificationListenerService

通过 Android 官方通知访问设置由用户授权，不自动授权，不使用 AccessibilityService 或其他方式替代。

只读取：

- Notification.EXTRA_TITLE。
- Notification.EXTRA_TEXT。
- Notification.EXTRA_BIG_TEXT。
- StatusBarNotification.packageName、key、postTime。
- App 显示名称；获取失败时使用包名。

BIG_TEXT 非空时优先作为最终 text，否则使用 TEXT。标题和正文都为空时忽略。不处理 MessagingStyle、textLines、RemoteViews、图片或通知操作按钮。

回调只做有限字段复制、基本过滤及异步发送交接，不阻塞主线程。异步交接只执行当前一次发送，不作为待发队列；没有执行余量或会话已结束时直接丢弃。

通知访问权限撤销或同步关闭后停止新采集与发送。监听器重绑使用自己的实际组件名，不循环启停组件，不扫描并重发整栏历史通知，也不拉起 LanChat 核心。

### 5.2 首版协议

~~~json
{
  "msg_type": "notification",
  "event_id": "...",
  "source_device_id": "A",
  "target_device_id": "B",
  "package": "com.example.app",
  "app_name": "应用名称",
  "title": "通知标题",
  "text": "通知正文",
  "notification_key": "...",
  "post_time": 0
}
~~~

| 字段 | 约定 |
| --- | --- |
| msg_type | 固定 notification；不重命名现有聊天和文件类型 |
| event_id | 本次通知事件标识，仅用于本次请求、结果和日志关联；不是内容去重键 |
| source_device_id | 从本机现有身份读取 |
| target_device_id | 用户选择的唯一目标设备 ID |
| package / app_name | 原始通知的应用来源 |
| title / text | 普通字符串，text 已按 BIG_TEXT 优先规则合并 |
| notification_key | 原始通知 key，用于更新 B 上已有通知 |
| post_time | Unix 毫秒；不与旧聊天秒时间戳混用，不承担可靠排序保证 |

建议整条载荷不超过 16 KiB，按最终序列化字节数检查并在字符边界截断正文。不传原始 Notification、PendingIntent 或远端执行指令。

两端必须升级到支持通知同步的版本。不增加版本协商或旧版通知兼容，不发送真实内容探测能力。notification 必须先分流到专用解析分支，不能当作普通 TextMessage 或流式聊天消息处理。

## 6. 发送与接收规则

### 6.1 A 端只尝试一次

A 仅在运行门禁、开关、允许列表和目标条件通过后，将系统产生的 notification event 提取、限长并发送。首版不维护 A 端内容去重表，也不实现发送侧节流；最终内容去重与通知更新统一由 B 执行。若以后实测 A 有大量完全重复回调，再单独讨论轻量节流。

PeerManager 在线状态仅作初筛，不证明目标此刻一定可达或 LanChat 仍运行。实际连接、发送及结果等待均设置短超时。

- 未选择目标、目标不存在或标记离线：直接丢弃。
- 连接失败、发送超时、B 拒绝或结果等待超时：直接丢弃。
- 不额外探活、不重连重试、不切换协议、不做 TCP 回退。
- 不排队、不持久保存，不在 peer 恢复或 App 重启后补发。
- 不进入现有聊天/文件的补发机制。

这些限制仅针对新增通知同步，不能删除或改变现有聊天与文件的补发能力。

### 6.2 B 端校验与展示

1. 现有 /ws 识别 notification，校验字段和载荷大小。
2. 必须满足 target_device_id == 本机 device_id，否则拒绝。
3. 拒绝来源为本机的通知，忽略 LanChat 自身包通知。
4. 校验通过后发布专用通知事件，不在 Rust 接收分支维护第二份内容去重状态。
5. 通过现有 CoreEventBus 和 Service 事件桥交给 B 的 SyncedNotificationPublisher，统一完成内存去重与更新。
6. 使用独立通知渠道和下述固定 tag/id 规则调用 NotificationManager，显示来源设备、App、标题与正文。

通知不写入普通聊天记录，不因为聊天 UI 可见就跳过展示；始终尊重系统通知权限、渠道及系统策略。锁屏正文默认按私密内容处理。点击只打开 LanChat，不执行远端载荷指定的 Intent 或自动回复。

### 6.3 仅 B 端去重、更新与通知标识

B 的 SyncedNotificationPublisher 是唯一的内容去重与通知更新位置，按以下三个字段组成的键维护一份有界内存记录。比较实际展示的 App 名称、标题和正文；event_id 或 post_time 单独变化不视为正文更新。

~~~text
同一 source_device_id + package + notification_key
    内容相同 → 忽略重复
    内容不同 → 更新 B 上同一条系统通知
~~~

只保存有界内存记录，不落盘，不增加 revision、跨进程指纹或跨崩溃 exactly-once。App 重启后不恢复历史，接受极端情况下少量重复、丢失或乱序更新。

系统通知标识算法固定为：

~~~text
tag = source_device_id + ":" + package + ":" + notification_key
id = 0
NotificationManager.notify(tag, id, notification)
~~~

不得将字符串 hash 为 int，不使用随机或递增通知 ID。同一远端通知始终使用同一 tag 和固定 id；不同来源设备、App 或 notification_key 使用不同 tag。通知 key 中的冒号按原字符串保留，不需要拆分 tag 反解字段。

成功调用系统通知接口后才更新 B 的内容记录；失败不标记为已经展示。内容相同的重复事件返回 success，不再次调用 notify。A 端和 B 的 Rust 接收分支不复制这份记录。

### 6.4 防回环

- A/B 的监听器永远忽略 LanChat 自己发布的通知。
- 网络接收路径只展示，不能重新进入通知发送路径。
- 不多跳转发，不广播给其他 peer。

### 6.5 简化结果与既有事件桥

结果仅使用 success/failure，回执定向返回当前请求的 WebSocket 连接；不为回执另建连接。等待超时后结束，不重试。

success 表示 B 已处理并成功调用系统通知接口，不能声称用户一定看到了横幅。可检测的权限、渠道或处理失败返回 failure，不建立更细的展示状态机。

复用现有 Service 订阅器，不增加独立待展示队列。CoreEventBus 不是可靠队列；若事件未处理导致超时，首版按失败结束。只有实测暴露丢事件问题，才单独讨论增强。

通知正文与定向回执不得进入 ws_broadcast。入口日志在打印原文前识别通知分支，日志只保留事件标识、大小和结果。

## 7. 同步时序

~~~mermaid
sequenceDiagram
    participant APP as A 其他 App
    participant NLS as A NotificationListener
    participant A as A 现有 Core / PeerManager
    participant B as B 现有 WebSocket / Core
    participant S as B 现有 Service 事件桥
    participant NM as B NotificationManager

    Note over NLS,NM: 用户已手动启动双方 LanChat，沿用既有运行会话
    APP->>NLS: onNotificationPosted
    NLS->>NLS: 读取 JVM 本地运行状态和原生持久设置，不调用 JNI
    alt 本机未运行或原生未就绪
        NLS->>NLS: 忽略，不调用 JNI，不启动后台
    else 当前会话有效
        NLS->>A: JNI 交接本次通知
        A->>A: 查找单一目标、在线初筛、限长；不做内容去重
        alt 未选择或目标不可达
            A->>A: 丢弃，不排队、不重试
        else 可以尝试发送
            A->>B: 现有 /ws 一次定向发送
            B->>B: 目标校验、解析；不维护内容去重表
            B->>S: 专用通知 CoreEvent
            S->>S: Publisher 按三字段键统一比较内容
            alt 内容相同
                S->>S: 忽略重复，结果为 success
            else 新通知或内容变化
                S->>NM: notify(来源设备:包名:原始key, 0, notification)
                NM-->>S: 调用结果
                S->>S: 调用成功才更新内容记录
            end
            S-->>B: 简单处理结果
            B-->>A: 当前连接 success / failure
            Note over A,B: 连接失败或等待超时即结束，不补发
        end
    end
    Note over NLS,NM: B 生成的本地通知被自身包过滤，不回传 A
~~~

## 8. 信任模型与性能边界

沿用现有 LAN 信任模型，不加入配对密钥、Keystore、AES/HMAC、认证加密、独立安全封装或协议级重放保护。

目标设备 ID 校验是路由检查，不是身份认证。通知在现有明文 LAN 通路上传输，可能被网络中的其他参与者窃听或伪造；此版本仅面向用户认可的可信自有网络，不适用于公共网络。不记录正文和不广播通知仍是本版必要的最小隐私边界。

小消息与文件已通过现有 WebSocket/HTTP 请求分开传输。首版不修改文件分块、并行度、带宽或内存策略：

> 若实测大文件传输显著阻塞通知，再单独优化。

回归应验证文件尚未结束时通知可以正常处理；如果确有长期阻塞，记录证据后单独解决并复验，不预先加入节流系统，也不把问题直接归咎于整套后台架构。

保持现有 Android SDK、FGS 类型、权限和锁策略。仅补充通知监听声明及授权引导，继续区分“通知访问权限”和“发布系统通知权限”。系统对敏感内容的删减、Doze 或 OEM 限制按实际结果记录，不增加绕过机制。

## 9. 预计修改文件与边界

下表路径相对实施基线 D:\SoftwareFree\LANChat-android-file-actions。新增名称是建议，不代表已经创建；优先复用现有模块，不为拆分而增加文件。

| 文件 | 修改目的 | 边界 |
| --- | --- | --- |
| src-tauri/gen/android/app/src/main/java/com/lanchat/app/LanChatNotificationListenerService.kt（新增） | 授权后的采集、允许列表、自身过滤与受控重绑 | 不启动 Service/Core，不管理 Socket |
| src-tauri/gen/android/app/src/main/java/com/lanchat/app/NotificationSyncSettings.kt（建议新增） | SharedPreferences 作为通知配置唯一来源，NLS 可直接读取 | 不依赖 JNI，不保存通知正文或待发项 |
| src-tauri/gen/android/app/src/main/java/com/lanchat/app/SyncedNotificationPublisher.kt（建议新增） | B 唯一内容去重表、固定 tag/id、渠道及简单展示结果 | 从既有 Service 调用，成功后更新记录 |
| src-tauri/gen/android/app/src/main/java/com/lanchat/app/LanChatForegroundService.kt | 专用通知事件处理，在既有结果/退出处理中维护只读 JVM 状态镜像 | 不改启动停止流程、返回模式或锁函数；NLS 读取不调用 JNI |
| src-tauri/gen/android/app/src/main/java/com/lanchat/app/MainActivity.kt | 通知访问设置、应用选择和设置桥接 | 不改启动和 UI 重建流程 |
| src-tauri/gen/android/app/src/main/AndroidManifest.xml | NLS 组件、BIND_NOTIFICATION_LISTENER_SERVICE 绑定权限及标准 intent-filter | 不新增开机入口，不改原 Service 声明和 FGS 类型 |
| src-tauri/src/android_service.rs | 当前运行会话内的通知 JNI 和展示结果衔接 | 保留原生启动、停止和事件订阅机制 |
| src-tauri/src/core_events.rs | 专用通知事件 | 不改变聊天/文件事件映射 |
| src-tauri/src/notification_sync.rs（建议新增） | 接收本次配置快照、目标检查、一次发送及协议校验 | 无内容去重表、持久设置副本、通知队列、补发或安全协议 |
| src-tauri/src/network/messaging.rs | 复用 /ws 的一次发送与简单回执接口 | 不改旧消息、文件发送及补发 |
| src-tauri/src/web_server.rs | notification 分流、定向结果及日志脱敏 | 不新增服务器、路由端口或正文广播 |
| src-tauri/src/commands.rs、src-tauri/src/lib.rs | 注册新增设置和通知接口 | 不改文件逻辑或 Core/UI 初始化 |
| src/index.html、src/js/ui.js、src/js/api.js | 四类通知设置、单一目标选择 | 不新增后台策略设置 |
| src-tauri/permissions/commands.toml、src-tauri/capabilities/mobile.json | 新命令所需的最小授权 | 不扩大无关权限 |
| src-tauri/gen/android/app/proguard-rules.pro | 保留新增 JNI 与必要回调 | 验证 release 包 |
| Android/Rust 现有测试及新增通知测试 | 协议、过滤、去重、运行门禁与回归 | 原 Service 生命周期契约测试继续保留 |

不新增 BootReceiver、后台启动协调器或 android_context.rs。不修改 android_fd.rs 的 SAF 冷启动路径，不新增通知数据库表或加密依赖。

若缺少在既有运行时执行一次发送所需的小接口，仅允许补充最小调用接口；不得借此重写 CoreRuntime 或新增独立网络运行时。

## 10. 三阶段实施与回滚

开始实施前确认实际后台代码基线和现有改动，记录冻结能力。新通知功能默认关闭。每阶段独立审查、验证和回滚。

| 阶段 | 内容 | 通过条件 | 回滚边界 |
| --- | --- | --- | --- |
| Phase 1：NotificationListenerService 与设置 | 通知授权、允许列表、三个文本字段、自身过滤、单一目标、JVM 本地运行门禁和原生持久设置 | NLS 不依赖 JNI 判断运行状态或读取配置；未运行不拉起；撤权和关闭生效 | 关闭通知采集并撤回新增组件/设置，旧生命周期不动 |
| Phase 2：notification 协议与 A→B | 现有 /ws 一次定向发送、目标校验、离线丢弃、防回环；A 不做内容去重 | 两端升级后定向事件到达；错误目标拒绝；任何发送失败不补发 | 撤回新增协议分支，不影响旧消息/文件 |
| Phase 3：B 端 NotificationManager 与回归 | B 唯一内容去重表、固定 tag/id 更新、来源展示、简单结果、大文件并发和原能力回归 | B 的 LanChat 已存在有效运行会话时，即使 UI 当前不可见，也能显示系统通知；去重、防回环、并发和稳定性通过 | 关闭通知功能并撤回展示代码，保留原系统通知行为 |

Phase 2 和 Phase 3 可以合并实施。Phase 2 尚未接入展示时只验证网络接收，不宣称系统通知已显示；完整 success 在展示接入后验收。

首次联网就启用过滤、限长、目标校验和防回环；首次接入 B 的系统通知展示时同步启用 B 唯一的内容去重逻辑，不先发布无去重的展示版本。真实通知正文不打印到日志中作为测试证据。

## 11. 验收清单

### 11.1 原有能力不回归

- [ ] 用户手动启动、划掉退出、显式退出和系统停止行为与当前版本一致。
- [ ] 前台接收消息和文件正常，文件内容校验一致。
- [ ] Home 后台、锁屏、息屏接收消息和文件正常。
- [ ] UI 重建不重复 Core、网络 Listener 或事件订阅。
- [ ] 多文件、文件保存及原有消息/文件补发正常。
- [ ] 既有 WakeLock、MulticastLock 行为不变。
- [ ] 退出后的任务、端口、锁和资源检查仍通过。
- [ ] 共享 Rust 变更不破坏 Windows 原有能力。

### 11.2 新通知功能

- [ ] 设置只允许选择一个转发对象，不能选择本机。
- [ ] 保存设备 ID，目标 IP 变化后使用 PeerManager 当前地址。
- [ ] 通知同步默认关闭、目标未选择、允许应用列表为空。
- [ ] UI 修改的同步开关、允许列表和目标 ID 已写入原生 SharedPreferences；NLS 不调用 Rust 即可直接读取，进程重建后配置仍保留。
- [ ] 只采集允许应用；系统短信 App 可以选择；自身通知被忽略。
- [ ] TITLE/TEXT/BIG_TEXT、空内容、超长 Unicode 文本处理正确。
- [ ] LanChat 未运行时，系统单独绑定 NLS 不启动 UI、Service、Core 或 JNI 冷启动。
- [ ] NLS 的运行门禁只读 Service 的 JVM 状态镜像；状态读取不调用 JNI、不触发原生库加载，未知或未就绪时安全忽略。
- [ ] 双方已手动启动后，前台、Home 后台、锁屏、息屏场景下 A→B 正常。
- [ ] 未选目标、目标不存在或离线时直接丢弃。
- [ ] 在线标记过期、连接失败、超时或 B 拒绝后不重试。
- [ ] 目标离线期间产生的通知，在目标重新上线后不补发。
- [ ] target_device_id 不匹配时 B 拒绝展示。
- [ ] 同 key 同内容不重复展示；内容变化更新原通知。
- [ ] A 不维护内容去重表；即使 event_id 不同，只要三字段键及展示内容相同，仍由 B 唯一记录表忽略重复。
- [ ] B 严格使用 source_device_id + ":" + package + ":" + notification_key 作为 tag、固定 id=0；不同来源通知互不覆盖，同一来源内容变化更新原项。
- [ ] 双方同时开启监听后不产生 A→B→A 回环。
- [ ] 权限撤销、同步关闭后不再启动新发送；重绑不重放历史通知。
- [ ] B 正确显示来源设备、App、标题和正文，系统通知权限/渠道关闭时正确处理。
- [ ] B 已有用户手动启动的有效会话，UI 当前不可见时仍显示系统通知；不将“从未打开 LanChat”作为支持场景。
- [ ] 通知不进入聊天记录、ws_broadcast 或原始正文日志。
- [ ] 大文件和多文件传输期间同步通知，不等待全部文件结束才处理；若实测阻塞，记录证据并单独优化后复验。
- [ ] 两小时持续运行，线程、内存、FD、Socket、订阅和去重记录无明显无界增长。

测试记录包括设备、Android/API、ROM、APK、授权、电池策略和网络条件。普通息屏与深度 Doze 分开记录，编译通过不能替代真机结果。无需新增开机恢复、无 UI 冷启动或划掉继续运行的正向验收；重点检查通知功能没有改变旧生命周期。

## 12. 不纳入本版与交付要求

不实现开机自启、划掉后继续运行、系统重建恢复或冷启动上下文改造；不增加后台恢复设置与运行意图仲裁。

不实现多目标、离线队列、TTL、重试补发、revision、持久去重、可靠消息系统、能力协商、复杂通知样式、黑名单、配对加密或事件总线可靠性重构。文件性能只按实测问题另行处理。

实施交付说明应包含实际改动、冻结能力回归、新功能测试、未验证边界和回滚方式，不补回已经移出的功能。

本轮仅修订 updatev3.md，不修改业务代码、不提交 Git。后续代码实施以用户明确指令为准。
