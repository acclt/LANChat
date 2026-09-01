# LQ Chat 0.2 构建与验收报告

更新：2026-09-01 12:38（北京时间）。**功能优化阶段的源码、自动化测试和候选构建已完成；Android/Windows 的真实通知点击、第二台设备及长稳等人工验收没有在本轮执行，不能标记为全部通过的稳定最终版。** 历史细节和证据索引见 device/ACCEPTANCE-before-build1023.md；下文明确区分本轮结果与上一阶段证据。

## 当前交付包

| 文件 | 核验结果 |
| --- | --- |
| LQ-Chat-0.2-build1024-android-arm64.apk | ARM64 Release，versionName 0.2 / versionCode 1024；v2/v3 签名、16 KiB ZIP 对齐、包名、单一 ARM64 ABI、JNI 导出与包内 `liblanchat.so` 哈希已自动核对。未安装或启动真机 App |
| LQ-Chat-0.2-functional-candidate-windows.exe | Windows x64 Release，文件版本 0.2.0；Release 构建完成并核对 SHA-256。未启动该桌面程序，未做本轮窗口或 Toast 人工验收；无 Authenticode 发布者签名 |

哈希见 SHA256SUMS.txt。Android 沿用上一候选相同的 Android Debug 证书（SHA-256 `7a2202c4ce757b245e833f848e7f9065713499872fddd193299f46f052bc0561`），不是正式商店发布证书。包内原生库与本轮 ARM64 Release 输出的 SHA-256 均为 `4011890e0d89c51582f6cb4c960d60d5b9268c809d63ff24c6623bc4319d378e`。旧 build1020 存在 Android 内置页面加载故障，不应使用取证备份 installed-before.apk。

## 功能优化阶段（build1024）

- 新增独立 `notification_history` 表，不进入 `messages`。唯一身份为方向、源设备、目标设备、包名和通知键；保存发送/接收方向、稳定记录 ID、历史设备名、状态/失败原因、本机观察/创建/更新时间和内容哈希。多目标逐目标记录。
- 历史按本机时间保留七天，启动、写入和读取时清理，不使用常驻定时器。图标按内容哈希保存一次引用，坏图标降级；过期后清理本功能目录中不再引用的图标。
- `notification_records` 支持方向、设备、包名、状态、页码和 1–100 页大小；另有按记录 ID 精确读取。默认页面读取最近 100 条，不再依赖进程内队列或固定约四条。
- Android 应用接口返回当前已安装且启用应用的包名、应用名、图标和已选状态，并返回 `installed_snapshot`；`replace_allowed` 一次替换完整允许列表，拒绝未安装/不可选择包，提交失败时恢复旧值。NLS 继续直接读取 Android SharedPreferences。
- Android 同步通知使用显式 `MainActivity` + `FLAG_IMMUTABLE` PendingIntent，携带 record/source/package/key；onCreate/onNewIntent 共用受限内部事件。记录过期时仍进入来源接收列表；设备删除但记录仍在时使用历史设备名。
- Windows Toast 使用同一 record/source 语义；运行中由原生 Activated 回调导航，冷启动只接受严格校验的 `history:<record>:<source>` 内部参数。没有注册可由任意 URI 注入的外部路由。
- 离线、连接失败、超时和拒绝只形成查看记录，不进入聊天 pending/resend 路径，不增加重试、补发或可靠消息系统。Android 仍为 START_NOT_STICKY、stopWithTask=true；未新增 Core 开机启动或无 UI 初始化。

### 本轮自动化与构建核验

| 检查 | 本轮结果 |
| --- | --- |
| Rust 全量测试 | 30 通过、1 个既有长时测试忽略；另有 WebSocket 通知集成测试 1 通过 |
| 历史边界 | 覆盖旧式数据库共存迁移、跨连接重开、严格七天边界、读写清理、内容去重/更新、多目标独立、筛选分页、坏图标降级 |
| 回归边界 | 通知不进入聊天表；离线记录但无补发；普通通知协议、Unicode/帧限制、进度过滤、聊天/文件及 Core 生命周期现有测试通过 |
| Android 编译 | ARM64 Rust Release、Release Kotlin/Gradle 和 AndroidTest Kotlin 均编译成功；AndroidTest 未在设备上执行 |
| Android 包 | package/version、v2/v3 签名、16 KiB 对齐、单 ARM64 `liblanchat.so`、JNI send/pending/complete 导出及内外原生库哈希通过 |
| Windows 包 | Release 构建和文件版本/SHA-256 通过；未启动 EXE，未把旧运行证据当成本轮运行结果 |

本轮测试只使用内存或 UUID 命名的临时 SQLite 数据和合成通知，没有读取或清空用户真实聊天。Android/Windows 界面与系统通知栏未由自动化控制。

## 实现边界

- 保持已有设备发现、PeerManager、WebSocket `/ws`、文件分片及后台生命周期；多目标按 device_id 发送，离线直接丢弃，不补发，不新增通知队列或网络管理器。
- NLS 先读 JVM 会话状态与原生设置；系统单独绑定 NLS 不启动 Core。Android 不新增开机恢复或划掉继续运行，START_NOT_STICKY、stopWithTask=true 不变。
- 接收端显示应用图标、名称、标题和正文；同 key 更新，系统发布者仍为 LQ Chat。
- 标准进度条从 0% 到 100% 以及不确定进度均过滤；去掉进度字段后的普通通知允许处理，不合成开始／结束通知。纯百分比文字不作为依据；非标准自定义进度不能保证识别。
- 历史 Tauri 插件已有 boot 声明，本轮未新增 LanChat Core 开机自启，不能说包内没有任何 boot 声明。

## 上一阶段（build1021–1023）发现与修复

1. Android Release 缺少 custom-protocol 导致内置 UI 访问开发代理；已修复并增加构建门禁，build1021 起启动正常。
2. 首页固定底部提示遮挡通知栏目；build1022 调整为正常布局流，实际手机布局复核通过。
3. 手机“读取已安装应用列表”权限关闭时，应用选择列表为空。用户授权后正常列出应用；build1023 增加空列表权限提示，没有自动修改系统权限。
4. SAF 保存成功，但旧下载接口将 content URI 当普通路径，返回 404。build1023 仅在原下载接口复用 AndroidFile 桥，读取数据库已记录的 URI；未改通信或文件调度。本次正式版读取复测通过。
5. 辅助 App 与正式 App 同名，曾误打开辅助包占用端口。未核对身份的一次探测命中辅助包，其 404 不能作为正式 build1023 失败证据。用户退出两者后，明确授权只打开正式包，完成复测。后续测试脚本增加设备身份与进程校验。

## 上一阶段 Android 已通过

设备为用户连接的 V2507A，Android API 36。仅使用合成测试通知／文件，不读取真实聊天内容。下列证据均位于 device/。

| 检查 | 结果与证据 |
| --- | --- |
| 13 项真机测试 | 全通过，涵盖实际 Android Builder 进度字段、清除进度、纯百分比文字、通知布局、图标边界、冷 NLS 门禁与 Service／SAF 接口契约；android-contract-tests.txt。进度项是生产过滤函数测试，不冒充实际发布进度通知的完整 NLS 链路 |
| 真实 NLS 普通通知 | 临时允许 Shell 后，系统合成通知实际到达 Windows，含图标、应用名及正文；未勾选应用被过滤。nls-first-notification.json、nls-unselected-app.json、nls-windows-first-history.json |
| 重复与更新 | A 可产生重复事件，B 保持同一个系统 tag/id，正文变化更新并保留图标。nls-windows-duplicate-history.json、nls-windows-updated-history.json |
| 开关与离线 | 关闭推送不发送，关闭接收回 failure，恢复不回放；目标断开时失败，重连不补发旧通知，新通知可到达。nls-push-disabled.json、receive-reenabled-no-backfill.json、nls-target-stopped.json、nls-target-reconnected.json、nls-new-after-reconnect.json |
| 页面与 UI 刷新 | 首页遮挡修复、接收详情图标／名称／正文显示通过；411 像素无横向溢出。页面 reload 后 Core generation、启动时间与 PID 不变，记录设置保留。home-build1022.png、receive-detail-build1022.png、ui-before-reload-build1022.json、ui-after-reload-build1022.json。此项不是 Android Activity.recreate |
| 主动退出／划掉 | 两条路径均停止通信服务；NLS 仍绑定时收到合成通知不重启 Core，手动启动恢复会话。services-after-explicit-stop.txt、services-task-removed-after-notification.txt、after-explicit-relaunch.json |
| SAF 保存 | 用户授权目录后，1 MiB 文件保存成功且 AVAILABLE，实体文件回读哈希一致。saf-export-check.json、saf-local-file-state.json |
| build1023 文件读取 | 正式设备身份核验后，既有接口返回 200，读取 1,048,576 字节，SHA-256 与原文件一致。saf-read-build1023.json |
| build1023 通知 | 初次／重复／更新 success（74/32/28 ms），错误目标／本机来源 failure（21/20 ms）；系统仅一条对应记录，id=0、稳定 tag，正文更新且图标保留。notification-e0f65309-e9f5-462b-8e3c-d05c28ac70da.json、build1023-received-records.json、build1023-system-notification.txt |

此前有效的 Wi-Fi 8/16/64 MiB 文件校验、文件期间 27 次通知（41–464 ms）、Home／短时息屏接收证据保留，索引见历史报告。短时结果不等同于两小时长稳。

## 上一阶段 Windows 与自动化

- build1023 EXE 曾使用独立临时数据库、端口 19877，普通聊天、8/16/64 MiB 文件、通知去重更新、非法目标拒绝、坏图标降级及文件期间六次通知全部通过。device/windows-build1023-regression.json；这些是上一阶段证据，不代表 build1024 功能候选已运行。
- 上一阶段实际宽屏／接收详情视觉证据保留，build1023 首页与宽屏布局曾实际打开。用户按 Esc 后停止电脑界面操作。本轮没有启动、退出或控制 Windows App。
- 上一阶段 Rust 库测试为 25 通过、1 个十分钟测试默认忽略；此前单独十分钟测试 600.03 秒、1501 心跳，优化路径 0 次数据库变化，见 idle-regression.json。本轮测试数量见前述 build1024 表格。
- 两小时 Windows 混合测试此前仅完成 18 轮，因持续弹窗干扰而停止，记为 interrupted，不能计为长稳通过；之后没有重启该循环，仅做有限短测。

## 尚未完成

1. 真实发布标准进度条通知，经 NLS 到接收端的完整过滤链路。生产过滤函数真机测试与普通通知完整链路已分别通过，不能合并冒充此项。
2. 第二台真实 Android 与 Windows 同时接收、真实双手机互选防回环；已有自动化不替代两手机实测。
3. Android Activity 重建、SAF 授权撤销／失效及原文件补发完整矩阵。
4. Windows 三档系统缩放、全部键盘操作、托盘菜单退出；Android／Windows 两小时混合长稳与最终资源释放。
5. build1024 Android 运行中/冷启动点击真实同步通知，分别验证精确定位、七天过期回退和已删除设备历史名称；目前只有意图契约测试已编译，未在设备执行。
6. build1024 Windows Toast 运行中/冷启动真实点击与焦点恢复；目前仅实现并自动测试内部参数校验，未启动候选 EXE 验收。
7. 真机已安装应用快照、搜索结果批量选择/清空和写入失败回滚的交互验收；当前原生接口与契约测试已编译，未在设备执行。

## 上一阶段设备收尾状态（本轮未复核）

- 上一阶段记录显示正式 Android com.lanchat.app build1023 当时已打开并保持有效会话；辅助 App 未启动。应用状态和默认保存目录见 device/build1023-runtime-check.json。本轮未检查当前设备状态。
- 仅取消临时 Shell 允许项，允许列表恢复为空；推送／接收开关、目标选择和其他设置不变。见 device/build1023-final-settings.json。真实推送前需由用户勾选所需应用。
- 用户系统权限未撤销；合成文件、目录与证据保留，未清空用户数据。
- device/saf-http-build1023.bin 是误命中辅助包的 404 文本，不是文件成功证据；正确依据为 saf-read-build1023.json。
- Windows 上一阶段最后已知为独立验收实例；本轮没有检查其当前状态，退出、快捷方式和资源收尾不得标记完成。
- 后续不主动操作电脑；需要代操作须明确授权，否则用“操作步骤：”编号列表交由用户执行。
