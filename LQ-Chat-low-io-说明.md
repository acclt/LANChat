# LQ Chat 0.19 Windows 空闲写盘优化版

日期：2026-08-31。仅调整 Windows 桌面端，原版程序保留。

## 使用

1. 如果旧版正在运行，右键系统托盘图标，选择“退出”。关闭窗口通常只是隐藏到托盘。
2. 桌面现有的“LQ Chat”快捷方式已绑定 `LQ-Chat-0.19-windows-low-io.exe`，并带有原数据库目录参数，直接双击即可。也可使用本目录的 `Start-LQ-Chat-low-io.cmd`。
3. 启动入口明确使用实际数据库目录 `D:\Data\lanchat`，即 `D:\Data\lanchat\lanchat.db`，不会迁移或改用另一个旧数据库。请优先使用此入口。

本次没有自动关闭原程序、替换旧 EXE 或调整开机启动项。需要回退时，正常退出优化版后启动原版即可；不要用旧备份覆盖试用期间新增的聊天记录。

桌面快捷方式修改前已确认没有 LQ Chat 后台进程。原快捷方式备份于 `C:\Users\L6HQ7\AppData\Local\LQChat\shortcut-backups\LQ Chat-before-low-io-20260831-082707.lnk`。此次只更新快捷方式，没有自动启动程序。

已通过 SQLite 在线备份机制生成一致性备份：`D:\Data\lanchat\backups\before-low-io-20260831-081937.db`。备份完整性检查通过。没有修改生产数据库的表结构、日志模式或同步安全设置。

## 行为变化

- 普通心跳、最后在线时间、在线／离线状态和可用内存仅保留在内存中，不保存到数据库，也不在定时器或退出时补写。
- 首次发现设备、设备名称或地址实际变化时，经过 1 秒合并窗口保存基本资料。重复心跳不产生新的保存任务；资料在窗口内恢复原值则跳过写入。
- 启动时历史设备先显示为离线／待确认，收到新心跳后恢复在线。心跳频率和超过 5 秒未见的判断规则保留。
- 聊天消息、文件记录、发送状态和手动设置继续按原方式保存。删除设备和聊天记录采用同一个事务，避免后台保存将已删除设备恢复。
- 数据库失败时保留最新待保存资料，按 5、15、30、60 秒退避重试。正常退出仅尝试完成待保存的基本资料，单次等待最多 2 秒；保存失败会记录错误。

Android 仍使用原来的设备保存路径；没有修改 Android 生命周期、权限或通知，没有重打包 APK。独立 Web 服务也不会自动启用本次策略。

## 验证记录

- Windows Release 桌面构建通过。
- Release 回归测试：19 项通过、0 项失败；10 分钟测试另行运行。覆盖重复心跳、重连、资料合并、保存期间资料变化又恢复、数据库锁竞争、删除回滚、失败重试、退出保存和退出错误报告。
- 本机回环 UDP 测试：100 个真实接收的数据包持续更新内存，设备数据库提交为 0。
- 1,500 次模拟状态更新和多次重连：数据库文件变更计数不增加，旧的在线时间和内存字段不变。
- Android ARM64 默认功能编译检查通过，包括共享 Rust 核心；不代表进行了安卓真机收发文件测试。
- Windows 独立 Web 服务入口编译检查通过，未启用新的设备保存策略。
- 10 分钟受控对照通过：600.02 秒内处理 1,501 次心跳。旧保存函数对应数据库变更计数增加 1,501；优化后的回环 UDP 接收路径对应计数增加 0，设备资料成功写事务为 0。测试模拟一个资料固定的已知设备，以约 2.5 次/秒覆盖此前实测的心跳处理频率；不是两个真实对端的实机测试。

对照测试原始输出：

```text
IDLE_DISK_COMPARISON seconds=600.02 heartbeats=1501 legacy_db_changes=1501 optimized_db_changes=0 optimized_profile_transactions=0
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 600.11s
```

受控测试使用独立临时数据库，没有向真实聊天数据库注入测试消息、锁竞争或故障。

## 限制

这里消除的是资料不变时的心跳数据库写入，不保证整机磁盘活动率为零。WebView2 缓存、心跳相关读取、聊天消息、文件传输、设备资料变化及系统其他程序仍可能产生 I/O。

尚未自动切换用户的日常运行实例，因此旧版／新版在相同真实对端、窗口和供电条件下的整盘活动、温度及风扇对照仍未完成；没有据此声称风扇问题已经解决。未进行断电或强制终止实验。突然终止可能丢失尚未提交的新设备资料，下次心跳会重新发现；聊天记录仍遵循原有保存方式。

## 构建标识

- 优化版大小：8,552,448 字节。
- 优化版 SHA256：`2EB9269DAC18CB89D55D43C61BC955768BDF57C20E40EE10B07F1EBD190FAB28`。
- 保留的原版 SHA256：`8C27C6EF1676BEC89EEC1B49F53B3EC2F0FE34BB4F6FFAB24B6A069864B6939F`。
- 源码：本目录 `src-tauri/src/peer_persistence.rs` 及 Windows 入口、设备发现与核心停止接入点。本次 Windows 优化已单独提交为 `eeb4d065df4dccff415fc6da9e3c59057ec54fb8`，推送至 `origin/codex/android-background-receiving`。已有版本调整、安卓相关改动和原先暂存的旧发布文件删除保留在本地，没有混入该提交。
- 可移植的优化说明随源码提交在 `docs/windows-idle-io.md`；本机数据库路径、备份、启动脚本及此本地说明未上传。

可重复运行的检查：

```text
cargo build --manifest-path src-tauri/Cargo.toml --release --bin lanchat --offline
cargo test --manifest-path src-tauri/Cargo.toml --release --lib --no-default-features --features web --offline -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features --features web --offline ten_minute_idle_heartbeat_disk_comparison -- --ignored --nocapture
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android --lib --offline
```

Android 编译检查使用已有 NDK 27 和 Android ARM64 Rust 目标，仅在检查进程内配置 NDK 编译器路径，没有修改项目的 Android 配置。
