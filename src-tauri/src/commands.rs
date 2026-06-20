// commands.rs - Tauri 命令（桌面端和移动端共享）
#[cfg(feature = "desktop")]
use crate::db::DbState;

#[cfg(feature = "desktop")]
use crate::peers::{Peer, PeerManager};

#[cfg(feature = "desktop")]
use std::sync::Arc;

#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager, State};

// 用于管理 PeerManager 的状态
#[cfg(feature = "desktop")]
pub struct PeerState {
    pub manager: Arc<PeerManager>,
}

#[cfg(feature = "desktop")]

/// 根据设备内存和文件大小计算最优分块大小
fn calculate_optimal_chunk_size(_file_size: usize) -> usize {
    #[cfg(feature = "desktop")]
    {
        use sysinfo::System;

        let mut sys = System::new_all();
        sys.refresh_all();

        // 获取可用内存（字节）
        let available_memory = sys.available_memory() as usize * 1024; // sysinfo 返回的是 KB

        // 使用可用内存的 80%（大胆使用内存以获得更快的速度）
        let max_chunk_memory = available_memory * 80 / 100;

        // 动态计算分块大小：使用可用内存的 80%，但最小 50MB，最大 500MB
        let chunk_size = std::cmp::max(
            50 * 1024 * 1024, // 最小 50MB
            std::cmp::min(
                max_chunk_memory,  // 使用可用内存的 80%
                500 * 1024 * 1024, // 最大 500MB
            ),
        );

        println!(
            "[Command] 系统可用内存: {} MB",
            available_memory / (1024 * 1024)
        );
        println!(
            "[Command] 内存预算: {} MB",
            max_chunk_memory / (1024 * 1024)
        );
        println!(
            "[Command] 计算的分块大小: {} MB",
            chunk_size / (1024 * 1024)
        );

        chunk_size
    }

    #[cfg(not(feature = "desktop"))]
    {
        // Web 端：使用保守的固定值
        println!("[Command] Web 端使用固定分块大小: 100 MB");
        100 * 1024 * 1024
    }
}

/// 统一的文件上传实现
/// 接受一个实现了 AsyncRead 的文件对象
async fn upload_file_internal<R: tokio::io::AsyncRead + Unpin>(
    app: &tauri::AppHandle,
    state: &State<'_, DbState>,
    peer_state: Option<&State<'_, PeerState>>,
    peer_id: String,
    peer_addr: String,
    file_name: String,
    file_size: usize,
    file_path_for_db: String,
    mut file: R,
    is_online: bool,
) -> Result<serde_json::Value, String> {
    // 决定存入数据库的状态：如果离线，那就是 pending 且不用显示上传中
    let overall_status = if is_online {
        "sent".to_string()
    } else {
        "pending".to_string()
    };
    let file_status = if is_online {
        "uploading".to_string()
    } else {
        "accepted".to_string()
    };

    let message_id = crate::db::save_file_message(
        &state.pool,
        peer_id.clone(),
        file_name.clone(),
        file_size,
        file_path_for_db.clone(),
        file_status,
        overall_status, // 传入状态
    )
    .await
    .ok();

    if !is_online {
        println!("[Command] 对方离线，文件保存为待上线");
        return Ok(serde_json::json!({
            "success": true, "file_name": file_name, "file_size": file_size,
        }));
    }

    // 获取自己的 ID（发送者 ID）
    let my_id = crate::db::get_user_id(&state.pool).await?;

    // 获取接收方的可用内存
    let receiver_memory_mb = if let Some(ps) = peer_state {
        let peers = ps.manager.get_all_peers();
        peers
            .iter()
            .find(|p| {
                p.addr
                    .starts_with(&peer_addr.split(':').next().unwrap_or(""))
            })
            .map(|p| p.available_memory_mb)
            .unwrap_or(1024)
    } else {
        1024
    };

    println!("[Command] 接收方可用内存: {} MB", receiver_memory_mb);

    // 分块上传
    let chunk_size = calculate_optimal_chunk_size(file_size);

    // 根据接收方内存调整分块大小（取发送方和接收方的最小值）
    let max_chunk_for_receiver = std::cmp::max(
        50 * 1024 * 1024,
        receiver_memory_mb as usize * 1024 * 1024 / 4,
    );
    let adjusted_chunk_size = std::cmp::min(chunk_size, max_chunk_for_receiver);

    println!(
        "[Command] 原始分块大小: {} MB, 调整后: {} MB",
        chunk_size / (1024 * 1024),
        adjusted_chunk_size / (1024 * 1024)
    );

    let total_chunks = (file_size + adjusted_chunk_size - 1) / adjusted_chunk_size;

    println!(
        "[Command] 开始分块上传: 文件大小={}, 分块大小={}, 总分块数={}",
        file_size, adjusted_chunk_size, total_chunks
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let upload_url = format!("http://{}/api/upload", peer_addr);

    let mut offset = 0;
    let mut chunk_index = 0;
    let start_time = std::time::Instant::now();

    loop {
        // 读取分块
        let mut buf = vec![0u8; adjusted_chunk_size];
        let mut bytes_read = 0;

        while bytes_read < adjusted_chunk_size {
            let n = tokio::io::AsyncReadExt::read(&mut file, &mut buf[bytes_read..])
                .await
                .map_err(|e| format!("读取文件失败: {}", e))?;

            if n == 0 {
                break;
            }

            bytes_read += n;
        }

        if bytes_read == 0 {
            break;
        }

        buf.truncate(bytes_read);
        let n = bytes_read;

        // 构造 multipart 请求
        let form = reqwest::multipart::Form::new()
            .text("peer_id", my_id.clone())
            .text("file_name", file_name.clone())
            .text("file_size", file_size.to_string())
            .text("chunk_index", chunk_index.to_string())
            .text("chunk_total", total_chunks.to_string())
            .part(
                "chunk",
                reqwest::multipart::Part::bytes(buf.clone())
                    .mime_str("application/octet-stream")
                    .map_err(|e| format!("设置 MIME 类型失败: {}", e))?,
            );

        println!(
            "[Command] 上传分块 {}/{}, 大小: {} 字节",
            chunk_index + 1,
            total_chunks,
            n
        );

        let response = client
            .post(&upload_url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                if let Some(id) = message_id {
                    let pool = state.pool.clone();
                    tokio::spawn(async move {
                        let _ = crate::db::delete_message_by_id(&pool, id).await;
                    });
                }
                format!("上传分块失败: {}", e)
            })?;

        if !response.status().is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "无法读取错误信息".to_string());
            eprintln!("[Command] ✗ 上传分块失败: {}", error_text);

            if let Some(id) = message_id {
                let _ = crate::db::delete_message_by_id(&state.pool, id).await;
            }

            return Err(format!("上传分块失败: {}", error_text));
        }

        // 检查是否秒传命中（接收端已有完整文件）
        if chunk_index == 0 {
            let resp_text = response.text().await.unwrap_or_default();
            if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&resp_text) {
                if resp_json.get("status").and_then(|s| s.as_str()) == Some("already_exists") {
                    println!("[Command] ✓ 秒传命中，接收端已有完整文件，停止上传");
                    // 更新本地数据库状态为 sent
                    if let Some(id) = message_id {
                        let _ = crate::db::update_file_status_by_id(&state.pool, id, "sent").await;
                    }
                    return Ok(serde_json::json!({
                        "success": true,
                        "file_name": file_name,
                        "file_size": file_size,
                        "instant_transfer": true,
                    }));
                }
            }
        }

        offset += n;
        chunk_index += 1;

        // 打印进度
        let elapsed = start_time.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            let speed = offset as f64 / (1024.0 * 1024.0) / elapsed;
            println!(
                "[Command] 已上传: {} MB, 速度: {:.2} MB/s",
                offset / (1024 * 1024),
                speed
            );
            let _ = app.emit(
                "upload_progress",
                serde_json::json!({
                    "file_name": file_name.clone(),
                    "speed_mb_s": speed
                }),
            );
        }
    }

    let total_time = start_time.elapsed().as_secs_f64();
    let avg_speed = file_size as f64 / (1024.0 * 1024.0) / total_time;
    println!(
        "[Command] ✓ 文件上传完成，耗时: {:.2}s, 平均速度: {:.2} MB/s",
        total_time, avg_speed
    );

    // 更新数据库状态为 "sent"
    if let Some(id) = message_id {
        if let Err(e) = crate::db::update_file_status_by_id(&state.pool, id, "sent").await {
            eprintln!("[Command] ⚠ 更新数据库状态失败: {}", e);
        } else {
            println!("[Command] ✓ 文件状态已更新为 sent");
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "file_name": file_name,
        "file_size": file_size,
    }))
}

#[cfg(target_os = "android")]
use std::os::unix::io::FromRawFd;

#[tauri::command]
pub async fn close_android_fd(#[allow(unused_variables)] fd: i32) {
    #[cfg(target_os = "android")]
    {
        if fd >= 0 {
            // 在 Rust 中，使用 from_raw_fd 接管 FD 的所有权。
            // 当这个 block 结束时，_file 会被 drop，Rust 会自动安全地调用底层的 close(fd)
            unsafe {
                let _file = std::fs::File::from_raw_fd(fd);
            }
            println!("[Rust] 成功释放被取消的共享文件描述符: {}", fd);
        }
    }
}

#[tauri::command]
pub async fn get_my_name(state: State<'_, DbState>) -> Result<String, String> {
    crate::db::get_username(&state.pool).await
}

#[tauri::command]
pub async fn get_my_id(state: State<'_, DbState>) -> Result<String, String> {
    crate::db::get_user_id(&state.pool).await
}

#[tauri::command]
pub async fn get_settings(state: State<'_, DbState>) -> Result<serde_json::Value, String> {
    let download_path = crate::db::get_download_path(&state.pool).await?;
    let port = crate::db::get_port(&state.pool).await?;
    let cfg = crate::config_file::read_config();
    let db_path = cfg.db_path.unwrap_or_else(crate::config_file::get_default_db_path);

    Ok(serde_json::json!({
        "download_path": download_path,
        "port": port,
        "db_path": db_path,
    }))
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, DbState>,
    download_path: Option<String>,
    port: Option<String>,
    db_path: Option<String>,
) -> Result<(), String> {
    if let Some(path) = download_path {
        crate::db::update_download_path(&state.pool, path).await?;
    }
    if let Some(ref p) = port {
        crate::db::update_port(&state.pool, p).await?;
    }
    if let Some(path) = db_path {
        if !cfg!(target_os = "android") {
            let mut cfg = crate::config_file::read_config();
            if path.is_empty() {
                cfg.db_path = None;
            } else {
                cfg.db_path = Some(path);
            }
            crate::config_file::write_config(&cfg)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_my_name(state: State<'_, DbState>, new_name: String) -> Result<String, String> {
    // 更新数据库
    crate::db::update_username(&state.pool, new_name.clone()).await?;

    // 数据库更新后，定时广播线程会自动使用新名称
    println!("[Command] 用户名已更新，广播线程将使用新名称");

    // 返回更新后的名字
    Ok(new_name)
}

#[tauri::command]
pub async fn get_peers(state: State<'_, PeerState>) -> Result<Vec<Peer>, String> {
    Ok(state.manager.get_all_peers())
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, DbState>,
    peer_state: State<'_, PeerState>,
    peer_id: String,
    mut peer_addr: String,
    content: String,
) -> Result<(), String> {
    println!("[Command] 收到发送消息请求: 发送给 {}", peer_id);
    let my_id = crate::db::get_user_id(&state.pool).await?;
    let my_name = crate::db::get_username(&state.pool).await?;

    // 提取状态时，顺便把后端内存里最新的 IP 拿出来
    let (is_offline_now, peer_name, backend_addr) = {
        let peers = peer_state.manager.get_all_peers();
        if let Some(p) = peers.iter().find(|p| p.id == peer_id) {
            (p.is_offline, p.name.clone(), Some(p.addr.clone()))
        } else {
            (true, "未知".into(), None)
        }
    };

    // 后端终极校验：如果前端传来的 IP 和后端最新的不一致，强制纠正！
    if let Some(latest_addr) = backend_addr {
        if latest_addr != peer_addr {
            println!(
                "[Command] 🛡️ 拦截到过期 IP，后端强行纠正: {} -> {}",
                peer_addr, latest_addr
            );
            peer_addr = latest_addr;
        }
    }

    if is_offline_now {
        println!(
            "[Command] 用户 {} 处于离线记录中，直接保存为挂起状态",
            peer_id
        );
        crate::db::save_text_message_with_status(
            &state.pool,
            peer_id,
            content,
            "pending".to_string(),
        )
        .await?;
        return Ok(());
    }

    // 3. 尝试发送（这同时也是一种探测）
    println!("[Command] 尝试发送消息给 {}({})...", peer_name, peer_addr);
    match crate::network::messaging::send_text_message(&peer_addr, my_id, my_name, content.clone())
        .await
    {
        Ok(_) => {
            // 发送成功
            crate::db::save_text_message_with_status(
                &state.pool,
                peer_id,
                content,
                "sent".to_string(),
            )
            .await?;
        }
        Err(e) => {
            // 发送失败（探测到实际已离线或网络故障）
            eprintln!("[Command] 发送失败(网络探测): {}. 消息将转入挂起队列。", e);

            // 立即更新本地状态，避免下次发送再次空转
            peer_state.manager.force_mark_offline(&peer_id);

            // 保存为挂起
            crate::db::save_text_message_with_status(
                &state.pool,
                peer_id,
                content,
                "pending".to_string(),
            )
            .await?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_chat_history(
    state: State<'_, DbState>,
    peer_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    crate::network::messaging::get_chat_history(&state.pool, &peer_id, 10).await
}

#[tauri::command]
pub async fn get_chat_history_with_offset(
    state: State<'_, DbState>,
    peer_id: String,
    limit: i32,
    offset: i32,
) -> Result<Vec<serde_json::Value>, String> {
    crate::network::messaging::get_chat_history_with_offset(&state.pool, &peer_id, limit, offset)
        .await
}

#[tauri::command]
pub async fn send_file(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    peer_id: String,
    mut peer_addr: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    println!(
        "[Command] 收到发送文件请求: {} -> {} ({})",
        file_path, peer_addr, peer_id
    );

    // 处理 file:// URI 格式
    let actual_path = if file_path.starts_with("file://") {
        // 移除 file:// 前缀并解码 URL 编码
        let path_without_prefix = &file_path[7..];
        urlencoding::decode(path_without_prefix)
            .map_err(|e| format!("解码 URI 失败: {}", e))?
            .to_string()
    } else {
        file_path.clone()
    };

    println!("[Command] 实际文件路径: {}", actual_path);

    // 检测是否是 Android content URI
    if actual_path.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            println!("[Command] 检测到 Android content URI，使用 FD 方式");

            // 使用 JNI 调用 Android ContentResolver 获取 FD
            use crate::android_fd::AndroidFile;

            // 从 content URI 获取文件描述符
            let android_file = AndroidFile::from_content_uri(&actual_path)?;
            let std_file = android_file.into_file();
            let file = tokio::fs::File::from_std(std_file);

            // 通过 ContentResolver 查询真实文件名和大小（OpenableColumns）
            let (mut file_name, file_size) =
                AndroidFile::query_content_uri_info(&actual_path).unwrap_or_default();

            // 兜底：文件名为空时从 URI 末段 + MIME 类型推断
            if file_name.is_empty() {
                println!("[Command] ContentResolver 未返回文件名，尝试从 URI 推断");
                let raw_seg = actual_path
                    .split('/')
                    .last()
                    .and_then(|s| urlencoding::decode(s).ok())
                    .map(|s| s.to_string())
                    .unwrap_or_default();

                // 去掉 "image:1000019507" 这类无意义前缀
                file_name = if let Some(idx) = raw_seg.rfind(':') {
                    raw_seg[idx + 1..].to_string()
                } else {
                    raw_seg
                };

                // 如果还是没有扩展名，用时间戳兜底
                if !file_name.contains('.') || file_name.is_empty() {
                    file_name = format!("file_{}.dat", chrono::Utc::now().timestamp());
                }
            }

            // 兜底：大小为 0 时尝试 fstat
            if file_size == 0 {
                println!("[Command] ContentResolver 未返回文件大小，尝试 fstat");
                // file 已经 move 进 tokio，无法再 stat；大小保持 0，上传完成后接收端会知道真实大小
            }

            println!("[Command] 文件名: {}, 大小: {} 字节", file_name, file_size);

            // 使用统一的上传函数
            let peer_state = app.try_state::<PeerState>();
            let (is_online, backend_addr) = peer_state
                .as_ref()
                .map(|s| {
                    if let Some(p) = s.manager.get_all_peers().iter().find(|p| p.id == peer_id) {
                        (!p.is_offline, Some(p.addr.clone()))
                    } else {
                        (false, None)
                    }
                })
                .unwrap_or((true, None));

            // 强制纠正文件接收端 IP
            if let Some(latest_addr) = backend_addr {
                if latest_addr != peer_addr {
                    println!(
                        "[Command] 🛡️ 拦截到过期文件传输 IP，后端强行纠正: {} -> {}",
                        peer_addr, latest_addr
                    );
                    peer_addr = latest_addr;
                }
            }
            return upload_file_internal(
                &app,
                &state,
                peer_state.as_ref(),
                peer_id,
                peer_addr,
                file_name,
                file_size as usize,
                actual_path,
                file,
                is_online,
            )
            .await;
        }

        #[cfg(not(target_os = "android"))]
        {
            return Err("content:// URI 仅在 Android 上支持".to_string());
        }
    }

    // 普通文件路径处理
    let file_name = std::path::Path::new(&actual_path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效的文件名")?
        .to_string();

    let file_metadata =
        std::fs::metadata(&actual_path).map_err(|e| format!("读取文件信息失败: {}", e))?;
    let file_size = file_metadata.len() as usize;

    println!("[Command] 文件: {}, 大小: {} 字节", file_name, file_size);

    // 打开文件
    let file = tokio::fs::File::open(&actual_path)
        .await
        .map_err(|e| format!("打开文件失败: {}", e))?;

    // 使用统一的上传函数
    let peer_state = app.try_state::<PeerState>();

    // 获取在线状态和最新的后端 IP
    let (is_online, backend_addr) = peer_state
        .as_ref()
        .map(|s| {
            if let Some(p) = s.manager.get_all_peers().iter().find(|p| p.id == peer_id) {
                (!p.is_offline, Some(p.addr.clone()))
            } else {
                (false, None)
            }
        })
        .unwrap_or((true, None));

    // 强制纠正文件接收端 IP
    if let Some(latest_addr) = backend_addr {
        if latest_addr != peer_addr {
            println!(
                "[Command] 🛡️ 拦截到过期文件传输 IP，后端强行纠正: {} -> {}",
                peer_addr, latest_addr
            );
            peer_addr = latest_addr; // 这里发生了修改，编译器的 mut 警告就会消失！
        }
    }
    upload_file_internal(
        &app,
        &state,
        peer_state.as_ref(),
        peer_id,
        peer_addr,
        file_name,
        file_size,
        actual_path,
        file,
        is_online,
    )
    .await
}

#[tauri::command]
pub async fn get_theme_list() -> Result<Vec<serde_json::Value>, String> {
    let mut themes = vec![
        serde_json::json!({
            "name": "default",
            "display_name": "默认主题",
            "is_custom": false,
            "is_builtin": true
        }),
        serde_json::json!({
            "name": "vscode",
            "display_name": "VSCode 主题",
            "is_custom": false,
            "is_builtin": true
        }),
    ];

    // 检查自定义主题目录
    let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let theme_dir = home_dir.join(".config").join("lanchat");

    if theme_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&theme_dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    let path = entry.path();
                    if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("css") {
                        if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
                            themes.push(serde_json::json!({
                                "name": file_name,
                                "display_name": file_name,
                                "is_custom": true,
                                "is_builtin": false,
                                "path": path.to_string_lossy()
                            }));
                        }
                    }
                }
            }
        }
    }

    println!("[Command] 找到 {} 个主题", themes.len());
    Ok(themes)
}

#[tauri::command]
pub async fn get_theme_css(theme_name: String) -> Result<String, String> {
    if theme_name == "default" {
        return Ok(String::new()); // 默认主题返回空字符串
    }

    // 检查是否是内置主题
    if theme_name == "vscode" {
        // 从嵌入的资源中读取 vscode.css
        let css_content = include_str!("../../src/css/vscode.css");
        println!(
            "[Command] 加载内置主题: vscode ({} 字节)",
            css_content.len()
        );
        return Ok(css_content.to_string());
    }

    // 自定义主题从用户目录读取
    let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
    let theme_path = home_dir
        .join(".config")
        .join("lanchat")
        .join(format!("{}.css", theme_name));

    if !theme_path.exists() {
        return Err(format!("主题文件不存在: {}", theme_path.display()));
    }

    let css_content =
        std::fs::read_to_string(&theme_path).map_err(|e| format!("读取主题文件失败: {}", e))?;

    println!(
        "[Command] 成功读取主题文件: {} ({} 字节)",
        theme_path.display(),
        css_content.len()
    );
    Ok(css_content)
}

#[tauri::command]
pub async fn save_current_theme(
    state: State<'_, DbState>,
    theme_name: String,
) -> Result<(), String> {
    // 保存当前主题到数据库
    crate::db::save_current_theme(&state.pool, theme_name.clone()).await?;

    println!("[Command] 主题设置已保存: {}", theme_name);
    Ok(())
}

#[tauri::command]
pub async fn get_current_theme(state: State<'_, DbState>) -> Result<String, String> {
    let result = crate::db::get_current_theme(&state.pool).await?;

    let theme = result.unwrap_or_else(|| "default".to_string());
    println!("[Command] 当前主题: {}", theme);
    Ok(theme)
}

#[tauri::command]
pub async fn get_default_download_path() -> Result<String, String> {
    if cfg!(target_os = "android") {
        // Android 的公共下载目录
        let download_path = "/storage/emulated/0/Download/LANChat";
        println!("[Command] Android 默认下载路径: {}", download_path);
        Ok(download_path.to_string())
    } else {
        // 桌面端和 Web 端返回用户下载目录
        let home_dir = dirs::home_dir().ok_or("无法获取用户主目录")?;
        let download_path = home_dir.join("Downloads").join("LANChat");
        println!("[Command] 默认下载路径: {}", download_path.display());
        Ok(download_path.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub async fn request_storage_permission() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        // Android 上需要请求存储权限
        // 注意：这个功能需要 Tauri 的 Android 插件支持
        // 目前先返回 true，假设权限已授予
        println!("[Command] Android 存储权限检查（假设已授予）");
        return Ok(true);
    }

    #[cfg(not(target_os = "android"))]
    {
        // 桌面端不需要权限
        Ok(true)
    }
}

#[tauri::command]
pub async fn save_file_message(
    state: State<'_, DbState>,
    peer_id: String,
    file_name: String,
    file_size: usize,
    file_path: String,
    status: String,
) -> Result<i64, String> {
    println!(
        "[Command] 文件: {}, 大小: {}, 状态: {}",
        file_name, file_size, status
    );

    // 使用数据库层的函数
    crate::db::save_file_message(
        &state.pool,
        peer_id,
        file_name,
        file_size,
        file_path,
        status,
        "sent".to_string(),
    )
    .await
}
#[cfg(feature = "desktop")]
#[tauri::command]
#[cfg_attr(target_os = "android", allow(unused_variables))]
pub async fn open_file_location(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_opener::OpenerExt;

        println!("[Command] 打开文件位置: {}", file_path);

        app.opener()
            .reveal_item_in_dir(&file_path)
            .map_err(|e| format!("打开文件位置失败: {}", e))?;

        println!("[Command] ✓ 文件位置已打开");
    }

    // Android 不支持"在文件管理器中显示位置"
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn set_android_shared_files(
    app: tauri::AppHandle,
    files: Vec<serde_json::Value>,
) -> Result<(), String> {
    println!(
        "[Command] set_android_shared_files 被调用，文件数: {}",
        files.len()
    );

    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        if let Some(share_state) = app.try_state::<AndroidShareState>() {
            share_state.set_files(files);
            println!("[Command] 文件已保存到状态");
            return Ok(());
        }

        println!("[Command] 没有找到分享状态");
        Err("分享状态未初始化".to_string())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, files);
        Err("此功能仅在 Android 上可用".to_string())
    }
}

#[tauri::command]
pub async fn get_android_shared_files(
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    println!("[Command] get_android_shared_files 被调用");

    #[cfg(target_os = "android")]
    {
        // 在 Android 上，从 MainActivity 获取分享文件
        // 通过 Tauri 的事件系统或状态管理获取
        // 这里我们使用一个全局状态来存储分享文件

        use tauri::Manager;

        // 尝试从应用状态获取分享文件
        if let Some(share_state) = app.try_state::<AndroidShareState>() {
            let files = share_state.get_files();
            println!("[Command] 从状态获取到 {} 个文件", files.len());
            return Ok(files);
        }

        println!("[Command] 没有找到分享状态");
        Ok(vec![])
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("此功能仅在 Android 上可用".to_string())
    }
}

#[tauri::command]
pub async fn clear_android_shared_files(app: tauri::AppHandle) -> Result<(), String> {
    println!("[Command] clear_android_shared_files 被调用");

    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        if let Some(share_state) = app.try_state::<AndroidShareState>() {
            share_state.clear_files();
            println!("[Command] 已清除分享文件");
        }

        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("此功能仅在 Android 上可用".to_string())
    }
}

// Android 分享状态管理
#[cfg(all(feature = "desktop", target_os = "android"))]
pub struct AndroidShareState {
    files: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
}

#[cfg(target_os = "android")]
impl AndroidShareState {
    pub fn new() -> Self {
        Self {
            files: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    pub fn set_files(&self, files: Vec<serde_json::Value>) {
        if let Ok(mut f) = self.files.lock() {
            *f = files;
            println!("[AndroidShareState] 已设置 {} 个文件", f.len());
        }
    }

    pub fn get_files(&self) -> Vec<serde_json::Value> {
        if let Ok(f) = self.files.lock() {
            println!("[AndroidShareState] 获取 {} 个文件", f.len());
            f.clone()
        } else {
            Vec::new()
        }
    }

    pub fn clear_files(&self) {
        if let Ok(mut f) = self.files.lock() {
            f.clear();
            println!("[AndroidShareState] 已清除文件");
        }
    }
}

#[cfg(all(feature = "desktop", not(target_os = "android")))]
pub struct AndroidShareState;

#[cfg(all(feature = "desktop", not(target_os = "android")))]
impl AndroidShareState {
    pub fn new() -> Self {
        Self
    }
}

#[tauri::command]
pub async fn send_file_from_fd(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    #[allow(non_snake_case)] peerId: String,
    #[allow(non_snake_case)] peerAddr: String,
    #[allow(non_snake_case)] fileName: String,
    #[allow(non_snake_case)] fileSize: usize,
    fd: i32,
    #[allow(non_snake_case)] originalUri: Option<String>,
) -> Result<serde_json::Value, String> {
    println!(
        "[Command] 收到从 FD 发送文件请求: fd={}, name={}, size={}, uri={:?}, to={}",
        fd, fileName, fileSize, originalUri, peerAddr
    );

    #[cfg(target_os = "android")]
    {
        use crate::android_fd::AndroidFile;

        // 从 FD 创建文件对象
        let android_file = AndroidFile::from_fd(fd)?;
        let std_file = android_file.into_file();
        let file = tokio::fs::File::from_std(std_file);

        // 使用原始 URI 作为 file_path（如果有），否则使用 fd:xxx
        let file_path = originalUri.unwrap_or_else(|| format!("fd:{}", fd));

        // 使用统一的上传函数，后端校验文件发送的 IP
        let peer_state = app.try_state::<PeerState>();
        let (is_online, backend_addr) = peer_state
            .as_ref()
            .map(|s| {
                if let Some(p) = s.manager.get_all_peers().iter().find(|p| p.id == peerId) {
                    (!p.is_offline, Some(p.addr.clone()))
                } else {
                    (false, None)
                }
            })
            .unwrap_or((true, None));

        let peer_addr = if let Some(latest_addr) = backend_addr {
            if latest_addr != peerAddr {
                println!(
                    "[Command] 🛡️ 拦截到过期文件传输 IP，后端强行纠正: {} -> {}",
                    peerAddr, latest_addr
                );
                latest_addr
            } else {
                peerAddr
            }
        } else {
            peerAddr
        };

        upload_file_internal(
            &app,
            &state,
            peer_state.as_ref(),
            peerId, 
            peer_addr,
            fileName.clone(),
            fileSize,
            file_path,
            file,
            is_online,
        )
        .await
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (
            app,
            state,
            peerId,
            peerAddr,
            fileName,
            fileSize,
            fd,
            originalUri,
        );
        Err("此功能仅在 Android 上可用".to_string())
    }
}

// 分享文件到其他应用（仅 Android）
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn share_file_to_other_app(
    #[allow(non_snake_case)] filePath: String,
) -> Result<(), String> {
    println!("[Command] 准备分享文件到其他应用: {}", filePath);

    use jni::objects::JValue;

    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|e| format!("获取 JavaVM 失败: {}", e))?;

    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("附加线程失败: {}", e))?;

    let activity = unsafe { jni::objects::JObject::from_raw(context.context().cast()) };

    let file_path_jstring = env
        .new_string(&filePath)
        .map_err(|e| format!("创建字符串失败: {}", e))?;

    env.call_method(
        activity,
        "shareFile",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&file_path_jstring)],
    )
    .map_err(|e| format!("调用 shareFile 失败: {}", e))?;

    println!("[Command] 分享文件命令已发送到 Android");
    Ok(())
}

// 非 Android 平台的空实现
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn share_file_to_other_app(
    #[allow(non_snake_case)] filePath: String,
) -> Result<(), String> {
    let _ = filePath;
    Err("此功能仅在 Android 上可用".to_string())
}

// 用对应应用打开文件（仅 Android）
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_file_in_android(#[allow(non_snake_case)] filePath: String) -> Result<(), String> {
    println!("[Command] 准备打开文件: {}", filePath);

    use jni::objects::JValue;

    let context = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
        .map_err(|e| format!("获取 JavaVM 失败: {}", e))?;

    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("附加线程失败: {}", e))?;

    let activity = unsafe { jni::objects::JObject::from_raw(context.context().cast()) };

    let file_path_jstring = env
        .new_string(&filePath)
        .map_err(|e| format!("创建字符串失败: {}", e))?;

    env.call_method(
        activity,
        "openFile",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&file_path_jstring)],
    )
    .map_err(|e| format!("调用 openFile 失败: {}", e))?;

    println!("[Command] 打开文件命令已发送到 Android");
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn open_file_in_android(#[allow(non_snake_case)] filePath: String) -> Result<(), String> {
    let _ = filePath;
    Err("此功能仅在 Android 上可用".to_string())
}

/// 获取媒体代理 Token（前端用于构造 /api/media 请求 URL）
#[tauri::command]
pub async fn get_media_token() -> String {
    crate::web_server::get_media_token()
}

// 读取剪贴板中的文件路径（桌面端）
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    println!("[Command] 读取剪贴板文件");

    #[cfg(all(not(target_os = "android"), feature = "clipboard-rs"))]
    {
        use clipboard_rs::common::RustImage;
        // 1. 优先尝试 Wayland (仅 Linux 桌面端)
        #[cfg(all(target_os = "linux", feature = "wl-clipboard-rs"))]
        {
            if let Ok(files) = try_read_wayland_clipboard().await {
                if !files.is_empty() {
                    println!("[Command] ✓ 通过 Wayland 读取到 {} 个文件", files.len());
                    return Ok(files);
                }
            }
        }

        // 2. Fallback: 使用 clipboard-rs
        println!("[Command] 尝试使用 clipboard-rs");
        use clipboard_rs::{Clipboard, ClipboardContext};

        let ctx = ClipboardContext::new().map_err(|e| format!("创建剪贴板上下文失败: {}", e))?;

        // 优先尝试读取本地文件路径
        if let Ok(files) = ctx.get_files() {
            if !files.is_empty() {
                println!(
                    "[Command] ✓ 通过 clipboard-rs 读取到 {} 个文件",
                    files.len()
                );
                return Ok(files);
            }
        }

        // 如果没有文件，尝试读取纯图片(截图)
        if let Ok(img) = ctx.get_image() {
            println!("[Command] 发现剪贴板图片，尝试生成临时文件...");

            let temp_dir = std::env::temp_dir();
            // 生成唯一文件名
            let file_name = format!(
                "screenshot_{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );
            let temp_path = temp_dir.join(file_name);
            let path_str = temp_path.to_string_lossy().to_string();

            // 借助 clipboard-rs 的 RustImageData 的 save_to_path 写入磁盘
            if img.save_to_path(&path_str).is_ok() {
                println!("[Command] ✓ 图片已保存至临时路径: {}", path_str);
                return Ok(vec![path_str]);
            }
        }

        Ok(vec![])
    }

    #[cfg(not(all(not(target_os = "android"), feature = "clipboard-rs")))]
    {
        Err("剪贴板功能不可用".to_string())
    }
}

// Wayland 剪贴板读取（仅 Linux 桌面端）
#[cfg(all(feature = "desktop", target_os = "linux", feature = "wl-clipboard-rs"))]
async fn try_read_wayland_clipboard() -> Result<Vec<String>, String> {
    use std::io::Read;
    use wl_clipboard_rs::paste::{get_contents, ClipboardType, MimeType, Seat};

    println!("[Command] 尝试通过 Wayland 读取剪贴板");
    // 1. 尝试读取 text/uri-list MIME 类型（文件列表）
    let uri_result = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::Specific("text/uri-list"),
    );
    if let Ok((mut pipe, _)) = uri_result {
        let mut contents = String::new();
        if pipe.read_to_string(&mut contents).is_ok() {
            let files: Vec<String> = contents
                .lines()
                .filter(|line| !line.is_empty() && line.starts_with("file://"))
                .map(|line| line.trim_start_matches("file://").to_string()) // 去除 file:// 前缀
                .collect();
            if !files.is_empty() {
                return Ok(files);
            }
        }
    }

    // 2. 尝试读取 image/png 类型（截图）
    let img_result = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::Specific("image/png"),
    );
    if let Ok((mut pipe, _)) = img_result {
        let mut buffer = Vec::new();
        if pipe.read_to_end(&mut buffer).is_ok() {
            let temp_dir = std::env::temp_dir();
            let file_name = format!(
                "screenshot_{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );
            let temp_path = temp_dir.join(file_name);

            if std::fs::write(&temp_path, &buffer).is_ok() {
                println!("[Command] Wayland: 成功读取截图并保存为临时文件");
                return Ok(vec![temp_path.to_string_lossy().to_string()]);
            }
        }
    }

    Err("剪贴板中既没有文件也没有图片".to_string())
}

// Web 端的空实现
#[cfg(not(feature = "desktop"))]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    Err("此功能仅在桌面端可用".to_string())
}

// Web 端的空实现
#[cfg(not(feature = "desktop"))]
pub struct PeerState;

#[cfg(not(feature = "desktop"))]
pub struct AndroidShareState;

#[cfg(not(feature = "desktop"))]
impl AndroidShareState {
    pub fn new() -> Self {
        Self
    }
}

// 批量删除消息
#[tauri::command]
pub async fn delete_messages(
    state: tauri::State<'_, crate::db::DbState>,
    msg_ids: Vec<i64>,
) -> Result<(), String> {
    println!("[Command] 批量删除消息: {:?}", msg_ids);
    crate::db::delete_messages_by_ids(&state.pool, msg_ids).await
}

#[tauri::command]
pub async fn clear_chat_history(
    state: tauri::State<'_, crate::db::DbState>,
    peer_id: String,
) -> Result<(), String> {
    let my_id = crate::db::get_user_id(&state.pool).await?;
    crate::db::clear_chat_history(&state.pool, &my_id, &peer_id).await
}

#[tauri::command]
pub async fn delete_user_complete(
    state: tauri::State<'_, crate::db::DbState>,
    peer_state: tauri::State<'_, PeerState>, // 必须引入这个来操作内存
    peer_id: String,
) -> Result<(), String> {
    let my_id = crate::db::get_user_id(&state.pool).await?;

    // 1. 删除数据库记录
    crate::db::delete_user_and_history(&state.pool, &my_id, &peer_id).await?;

    // 2. 同步删除内存中的用户状态，否则 apiGetPeers 还会返回它
    peer_state.manager.remove_peer(&peer_id);

    Ok(())
}

// ── 自定义 IP 命令 ──

#[tauri::command]
pub async fn get_custom_peers(state: tauri::State<'_, crate::db::DbState>) -> Result<Vec<String>, String> {
    Ok(crate::db::get_custom_peers(&state.pool).await)
}

#[tauri::command]
pub async fn add_custom_peer(state: tauri::State<'_, crate::db::DbState>, peer: String) -> Result<(), String> {
    crate::db::add_custom_peer(&state.pool, &peer).await
}

#[tauri::command]
pub async fn remove_custom_peer(state: tauri::State<'_, crate::db::DbState>, peer: String) -> Result<(), String> {
    crate::db::remove_custom_peer(&state.pool, &peer).await
}

#[tauri::command]
pub async fn get_notifications_enabled(state: tauri::State<'_, crate::db::DbState>) -> Result<bool, String> {
    Ok(crate::db::get_notifications_enabled(&state.pool).await)
}

#[tauri::command]
pub async fn set_notifications_enabled(state: tauri::State<'_, crate::db::DbState>, enabled: bool) -> Result<(), String> {
    crate::db::set_notifications_enabled(&state.pool, enabled).await
}

#[tauri::command]
pub fn show_notification(_app: tauri::AppHandle, title: String, body: String) {
    #[cfg(windows)]
    {
        // Windows 使用 PowerShell（不依赖 Start Menu 注册）
        let safe_title = title.replace('\'', "''");
        let safe_body = body.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $n = New-Object System.Windows.Forms.NotifyIcon; \
             $n.Icon = [System.Drawing.SystemIcons]::Information; \
             $n.Visible = $true; \
             $n.ShowBalloonTip(5000, '{safe_title}', '{safe_body}', [System.Windows.Forms.ToolTipIcon]::None)"
        );
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .spawn();
    }

    #[cfg(target_os = "linux")]
    {
        // Linux 用 notify-send
        let _ = std::process::Command::new("notify-send")
            .arg(&title)
            .arg(&body)
            .spawn();
    }

    #[cfg(any(target_os = "macos", target_os = "android"))]
    {
        // macOS / Android 通过 notification plugin
        use tauri_plugin_notification::NotificationExt;
        let app = _app;
        let _ = app.notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
    }
}
