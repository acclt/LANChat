# LQ Chat 0.2 构建与验收报告

更新：2026-08-31 21:26（北京时间）。状态：**真机验收进行中，尚未达到 v4 全部验收门槛**。不能将当前包称为“全部验收通过的稳定最终版”。本报告替换此前“无真机连接”的报告，旧报告保存在 device/ACCEPTANCE-before-device.md。

## 当前安装包

| 文件 | 版本与状态 |
| --- | --- |
| LQ-Chat-0.2-android-arm64.apk | ARM64 Release，versionName 0.2 / versionCode 1022；修复离线内置 UI 加载和首页底部遮挡。真机已安装 build1022，已回读安装 APK 并确认哈希与交付包完全一致；新布局的真机视觉复核待做 |
| LQ-Chat-0.2-windows.exe | Windows x64 Release，文件／产品版本 0.2.0；已实际启动、重启并通过本机通信回归；两小时混合运行因弹窗干扰而中断，未完成 |

SHA-256 见 SHA256SUMS.txt。**原 build1020 有 Android 页面加载故障，已从交付文件名替换，不应继续使用。** device/installed-before.apk 仅是故障版本取证备份。

Android 沿用既有本机开发证书，SHA-256：`7a2202c4ce757b245e833f848e7f9065713499872fddd193299f46f052bc0561`。Release 为不可调试构建，v2/v3 签名与 16 KiB ZIP 对齐通过；开发证书不代表正式商店发布签名。Windows EXE 没有 Authenticode 发布者签名。

## 功能范围不变

- 复用现有设备发现、PeerManager 和 `/ws`，按 device_id 多目标定向发送；离线、失败、超时直接丢弃，不增加离线队列、补发或新端口。
- Android 原生设置可直接读取；NLS 先经过 JVM 会话门禁，自身包过滤和允许列表，再处理通知。系统单独绑定 NLS 不启动 Core。
- Android／Windows 接收端显示来源应用图标、应用名称、标题、正文及时间；同 key 内容更新。系统发布者身份仍为 LQ Chat，不冒充来源应用。
- 标准进度 0%、中间、100%、不确定进度全部过滤。清除进度条后的普通通知允许处理；不推断完成、不合成结束通知。无标准字段的自定义进度无法保证识别；纯百分比文字不作为进度依据。
- 不新增 Android 开机恢复、划掉继续运行、Sticky 或后台协调器。START_NOT_STICKY、stopWithTask=true 保持原样。

## 本次真机续验发现与修复

1. 已安装的 build1020 与旧交付 APK 哈希一致，但 Android 显示 `tauri.localhost` 加载失败。原因是手动构建移动端 Rust Release 时未启用 Tauri `custom-protocol`，仍走移动开发服务器代理。新增对应 Cargo feature；Android Release 构建缺少该 feature 时立即报错，避免再次打出这种包。build1021 真机内置 UI 已正常启动。
2. 真机首页底部固定提示与通知栏目重叠。build1022 仅对 Android 通知首页调整底部提示为正常布局流，未更改后台通信或生命周期；build1022 已确认安装且包哈希匹配；视觉复核仍待做。
3. 设备测试改用独立 `com.lanchat.app.acceptance` 包及 AndroidJUnitRunner，避免会话门禁测试影响用户正式 App 数据。辅助包和测试包已构建并复制到手机，尚未检测到安装。
4. Windows 旧验收进程经 App 设置与窗口 X 正常退出；恢复原 close_to_tray 偏好后，启动新 EXE。第一次测试启动误将文件路径传给要求目录的 CLI 参数，产生 DB 路径错误；纠正测试参数后正常启动，未操作用户聊天库。

## 本次已通过：Android 真机 build1021

设备：用户连接的 V2507A，Android API 36；手机与 Windows 已在用户更换后的同一局域网。系统通知权限与 NLS 访问权限由用户授予。

| 检查 | 实测结果与证据 |
| --- | --- |
| 升级和启动 | 用户覆盖安装 build1021；内置页面正常打开，前台服务运行，设备身份未变 |
| 接收系统通知 | 通过真实 Wi-Fi `/ws` 收到合成通知。通知栏折叠／展开图均显示应用图标、应用名、标题、正文和时间：device/notification-shade-build1021.png、notification-expanded-build1021.png |
| 去重与更新 | 初次、重复、更新均回 success；同 key 更新后系统仅保留一个对应 NotificationRecord，tag 基于来源／包名／key、id=0；错误目标和本机来源回 failure。见 device/notification-ec2d096e-5760-4dbb-affe-4969a5a826b1.json |
| 手机到 Windows | 真机 App 内“发送测试通知”定向发至独立 Windows 验收实例；实际 Windows 卡片与系统历史均包含图标、应用名和正文。见 device/windows-from-phone.jpg、windows-from-phone-history.json。**该按钮不证明真实 NLS 采集已验收** |
| 聊天与三文件 | Wi-Fi 传输 8、16、64 MiB 三个合成文件，下载回读 SHA-256 均一致；普通聊天获得回执。见 device/transport-64fac2b3-3c67-400d-8f65-32a81620b88a.json。此项使用默认接收存储，不是 SAF 导出验收 |
| 实际 Wi-Fi 并发 | 三文件传输／回读期间，27 次通知全部 success，41–464 ms，三个文件校验一致。见 device/transport-fb70abab-528b-4276-a872-ddb4460e00f8.json。约 13 秒样本，不等同于长稳或任意网络性能保证 |
| Home 后台 | 返回 Home 后通知处理 success，25 ms，见 device/background-c185ca10-91a1-4b0f-90bd-dbbd5dcb3581.json |
| 息屏／锁屏 | 系统进入 Dozing 时 success 116 ms；约 45 秒后 Asleep 时 success 35 ms。见 device/background-6cadb9ef-53de-4f46-815c-dc7701ac81e8.json、background-1fc98475-4ed1-4142-9d7d-c9cad3242330.json。未绕过手机解锁 |

## 本次已通过：最终 Windows EXE

使用正式程序身份、独立临时数据库及端口 19877；没有以网页模拟替代实际客户端。

- App 内设置保存成功；关闭“点击 X 时最小化到托盘”后，窗口 X 使旧验收进程正常退出。原用户配置文件已逐字段核对并恢复。
- 新 EXE 实际启动，接收开关的持久设置保留；前一运行会话的通知记录按设计不恢复。
- 新包重新通过普通聊天、8/16/64 MiB 三文件哈希、通知去重／更新、错误目标和本机来源拒绝、坏图标降级，以及文件期间六次通知处理（5–48 ms）。见 device/windows-build1022-regression.json。
- 系统通知历史确认应用名、分栏结构和可读本地图标；见 device/windows-build1022-notification-history.json。
- 实际宽窗口首页与接收详情可用，侧栏稳定、图标／名称／内容显示正常；见 device/windows-build1022-wide.jpg、windows-build1022-detail.jpg。尚未完成三档 Windows 系统缩放及全部键盘操作。
- 两小时混合运行于 21:16:22 开始，每约 30 秒发送一轮合成聊天、文件和通知。用户反馈 Windows 持续弹窗后，已停止唯一对应的合成发送进程（PID 14124），确认退出；App 本身未关闭。实际完成 18 轮，未达到两小时，状态记为 interrupted，不能计为长稳通过。见 device/windows-two-hour-soak.json。此前 Esc 只停止了电脑界面操作，没有终止此后台脚本；已纠正报告和运行状态，不会自行重启批量弹窗测试。

## 自动化、构建与之前的有效证据

- 当前源码 Rust 库测试重新执行：25 通过，1 个十分钟测试按默认规则忽略。
- 此前十分钟受控心跳测试：600.03 秒、1501 次心跳，旧路径 1501 次数据库变化，优化路径 0 次变化。原数据见 idle-regression.json；不替代两小时混合运行。
- 此前 WebSocket 集成检查通过：慢／离线目标不阻塞其他目标、结果关联、去重目标、通知不广播／不写聊天、停止清理。当前源码复跑同一集成测试也通过（1 项，5.58 秒）。
- 此前实际前端合成测试覆盖多目标、离线选择、App 搜索、保存失败回退、长正文展开、缺图回退；桌面和手机多种视口无横向溢出。这是前端检查，不当作每款手机和 Windows 系统缩放实测。
- Android build1022：Release 构建、签名、16 KiB ZIP 对齐、包内原生库与构建输出哈希匹配通过，见 device/build1022-package-check.json。
- Android Release 缺少 custom-protocol 的负向构建验证确实被新增门禁拒绝；正常带 feature 构建成功。
- Windows Release 构建、文件版本、哈希、--help 通过。JS 语法与正常仓库配置下 git diff --check 通过；没有将既有换行提示当作功能失败。

## 仍需完成，不能标记通过

1. build1022 已安装（versionCode 1022，安装 APK 哈希与交付包一致）；首页布局与启动复核待完成。
2. 13 项 Android 设备测试的执行结果，尤其进度字段、清除进度、冷 NLS 门禁和通知布局。辅助包尚待用户安装；此前 USB 安装被系统拒绝后未绕过。
3. 真实允许列表应用经 NLS 采集的普通通知／进度过滤完整链路；允许列表当前为空，App 内手动测试通知不替代该项。
4. Android UI 重建、任务划掉／显式退出边界、SAF 导出及原文件补发完整回归；不能从签名、静态接口或短时息屏结果推断这些全部通过。
5. 同时推送至第二台真实 Android 与 Windows、真实互选防回环；已有自动化的多目标／自身包过滤证据不能替代两手机实测。
6. Windows 三档系统缩放、全部键盘操作、托盘菜单退出；以及尚未完成的长稳与最终资源释放。Android 两小时混合运行尚未开始。

## 数据隔离与收尾状态

Windows 使用 `%TEMP%/lanchat-v4-icons-native-check`，不读写用户正式聊天数据库。真机只发送带 acceptance02 标识的合成聊天、文件和通知；未清空现有数据、未撤销用户权限。

Windows 验收 App 实例 PID 4960，使用端口 19877；合成发送脚本已停止，不再为长稳测试主动发送。正式使用交付 EXE 前必须正常退出它，否则单实例机制会恢复测试窗口。不要强制关闭用户其他程序。长稳结束后还需清理明确命名的合成系统通知，并复核开始菜单快捷方式；测试脚本和所有证据保留。

历史 Manifest 已有 Tauri 通知插件的 LocalNotificationRestoreReceiver / boot 权限，本轮没有新增 LanChat Core 开机自启；也不能宣称包内完全没有任何 boot 声明。
