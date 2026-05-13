use socket2::{Domain, Protocol, Socket, Type};
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter};

use crate::peers::PeerManager;

#[cfg(not(feature = "desktop"))]
type AppHandle = ();

const MULTICAST_IP: &str = "224.0.0.167";

// 创建支持广播和组播的 UDP socket
fn create_discovery_socket(
    bind_addr: &str,
    is_listener: bool,
) -> Result<UdpSocket, std::io::Error> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;

    #[cfg(target_os = "windows")]
    socket.set_reuse_address(true)?;

    #[cfg(not(target_os = "windows"))]
    {
        socket.set_reuse_address(true)?;
        socket.set_reuse_port(true)?;
    }

    let addr: std::net::SocketAddr = bind_addr
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    socket.bind(&addr.into())?;

    let std_socket: UdpSocket = socket.into();

    if is_listener {
        let multi_addr: Ipv4Addr = MULTICAST_IP.parse().unwrap();
        let interface: Ipv4Addr = "0.0.0.0".parse().unwrap();
        let _ = std_socket.join_multicast_v4(&multi_addr, &interface);
    } else {
        std_socket.set_broadcast(true)?;
        let _ = std_socket.set_multicast_ttl_v4(1);
    }

    Ok(std_socket)
}

// 核心黑科技：生成全网段广播地址（绕过 Android 网卡读取限制）
fn get_smart_broadcast_addresses(port: u16) -> Vec<String> {
    let mut addrs = Vec::with_capacity(260);

    // 1. 全局受限广播 (应对普通路由器)
    addrs.push(format!("255.255.255.255:{}", port));
    // 2. 组播 (PC端互联完美生效)
    addrs.push(format!("{}:{}", MULTICAST_IP, port));
    // 3. 苹果 iOS 热点固定广播地址
    addrs.push(format!("172.20.10.15:{}", port));
    // 4. 常见企业路由器网段
    addrs.push(format!("10.0.0.255:{}", port));

    // 5. Android 随机热点网段 "暴力"覆盖 (192.168.0.255 ~ 192.168.255.255)
    // 那些没有对应网卡的地址会在微秒级被内核路由表直接丢弃，不会产生网络风暴
    for i in 0..=255 {
        addrs.push(format!("192.168.{}.255:{}", i, port));
    }

    addrs
}

pub async fn start_announcing(port: u16, user_id: String, pool: sqlx::Pool<sqlx::Sqlite>) {
    let socket = match create_discovery_socket("0.0.0.0:0", false) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[UDP] 创建发送 socket 失败: {}", e);
            return;
        }
    };

    println!("[UDP] 开始通过智能路由遍历发送心跳...");

    use sysinfo::System;
    let mut sys = System::new();
    let target_addrs = get_smart_broadcast_addresses(port);

    loop {
        let username = match crate::db::get_username(&pool).await {
            Ok(name) => name,
            Err(_) => "Unknown".to_string(),
        };

        sys.refresh_memory();
        let available_memory_mb = sys.available_memory() / (1024 * 1024);

        let msg = format!(
            "LANChat|ONLINE|{}|{}|{}|{}",
            user_id, username, port, available_memory_mb
        );

        // 核心：遍历所有可能地址，仅路由存在的网卡能发送成功
        for addr in &target_addrs {
            let _ = socket.send_to(msg.as_bytes(), addr);
        }

        // 成功数量通常是 2~4 个（组播 + 全局 + 刚好撞中的你的 84 热点网段等）
        // println!("[UDP] 心跳发送成功，激活了 {} 个真实路由网段", success_count);

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

// 桌面端版本 - 带 AppHandle
#[cfg(all(feature = "desktop", not(feature = "web")))]
pub async fn start_listening(
    port: u16,
    my_id: String,
    _my_name: String,
    app: Option<AppHandle>,
    peer_manager: Arc<PeerManager>,
    pool: sqlx::Pool<sqlx::Sqlite>,
) {
    let bind_addr = format!("0.0.0.0:{}", port);
    let socket = match create_discovery_socket(&bind_addr, true) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[UDP] 创建监听 socket 失败: {}", e);
            return;
        }
    };

    let mut buf = [0u8; 1024];
    println!("[UDP] 正在端口 {} 监听邻居...", port);

    loop {
        if let Ok((size, addr)) = socket.recv_from(&mut buf) {
            let msg = String::from_utf8_lossy(&buf[..size]);
            let parts: Vec<&str> = msg.split('|').collect();

            if parts.len() >= 6 && parts[0] == "LANChat" {
                let peer_id = parts[2].to_string();
                let name = parts[3].to_string();
                let peer_port = parts[4];
                let available_memory_mb: u64 = parts[5].parse().unwrap_or(0);

                if peer_id == my_id {
                    continue;
                }

                let peer_addr = format!("{}:{}", addr.ip(), peer_port);

                let is_new_or_reconnected = peer_manager.add_or_update_with_memory(
                    peer_id.clone(),
                    name.clone(),
                    peer_addr.clone(),
                    available_memory_mb,
                );

                // 保存或更新用户到数据库
                let _ = crate::db::save_or_update_user(
                    &pool,
                    peer_id.clone(),
                    name.clone(),
                    peer_addr.clone(),
                    false,
                    available_memory_mb,
                )
                .await;

                // 只在新用户或重新上线时打印日志
                if is_new_or_reconnected {
                    println!(
                        "[UDP] 发现用户: {} ({}) at {} (可用内存: {} MB)，准备检查补发队列...",
                        name, peer_id, peer_addr, available_memory_mb
                    );

                    let pool_clone = pool.clone();
                    let peer_id_clone = peer_id.clone();
                    let peer_addr_clone = peer_addr.clone();
                    let app_clone = app.clone();

                    // 扔进后台线程执行，不要阻挡 UDP 监听其他用户的广播！
                    tokio::spawn(async move {
                        if let Err(e) = resend_pending_messages(
                            &pool_clone,
                            &peer_id_clone,
                            &peer_addr_clone,
                            app_clone,
                        )
                        .await
                        {
                            eprintln!("[UDP] 补发消息严重失败: {}", e);
                        }
                    });
                }

                if let Some(app_handle) = &app {
                    let _ = app_handle.emit("new-peer", serde_json::json!({
                        "id": peer_id, "name": name, "addr": peer_addr, "available_memory_mb": available_memory_mb
                    }));
                }
            }
        }
    }
}

// Web 端版本 - 不带 AppHandle
#[cfg(all(feature = "web", not(feature = "desktop")))]
pub async fn start_listening(
    port: u16,
    my_id: String,
    _my_name: String,
    peer_manager: Arc<PeerManager>,
    pool: sqlx::Pool<sqlx::Sqlite>,
) {
    let bind_addr = format!("0.0.0.0:{}", port);
    let socket = match create_discovery_socket(&bind_addr, true) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[UDP] Web端创建监听 socket 失败: {}", e);
            return;
        }
    };

    let mut buf = [0u8; 1024];
    loop {
        if let Ok((size, addr)) = socket.recv_from(&mut buf) {
            let msg = String::from_utf8_lossy(&buf[..size]);
            let parts: Vec<&str> = msg.split('|').collect();

            if parts.len() >= 6 && parts[0] == "LANChat" {
                let peer_id = parts[2].to_string();
                let name = parts[3].to_string();
                let peer_port = parts[4];
                let available_memory_mb: u64 = parts[5].parse().unwrap_or(0);

                if peer_id == my_id {
                    continue;
                }
                let peer_addr = format!("{}:{}", addr.ip(), peer_port);

                let is_new_or_reconnected = peer_manager.add_or_update_with_memory(
                    peer_id.clone(),
                    name.clone(),
                    peer_addr.clone(),
                    available_memory_mb,
                );

                // 保存或更新用户到数据库
                let _ = crate::db::save_or_update_user(
                    &pool,
                    peer_id.clone(),
                    name.clone(),
                    peer_addr.clone(),
                    false,
                    available_memory_mb,
                )
                .await;

                // 用户重新上线，补发挂起的消息
                if is_new_or_reconnected {
                    println!("[UDP] 发现用户或重新上线，准备检查补发队列...");
                    let pool_clone = pool.clone();
                    let peer_id_clone = peer_id.clone();
                    let peer_addr_clone = peer_addr.clone();

                    // 扔进后台线程执行，不要阻挡 UDP 监听其他用户的广播！
                    tokio::spawn(async move {
                        if let Err(e) = resend_pending_messages(
                            &pool_clone,
                            &peer_id_clone,
                            &peer_addr_clone,
                            None,
                        )
                        .await
                        {
                            eprintln!("[UDP] 补发消息严重失败: {}", e);
                        }
                    });
                }
            }
        }
    }
}

// 发送单次广播
pub async fn send_single_broadcast(
    port: u16,
    user_id: String,
    username: String,
) -> Result<(), String> {
    let socket = create_discovery_socket("0.0.0.0:0", false)
        .map_err(|e| format!("创建发送socket失败: {}", e))?;

    let msg = format!("LANChat|ONLINE|{}|{}|{}|0", user_id, username, port);
    let target_addrs = get_smart_broadcast_addresses(port);

    for addr in target_addrs {
        let _ = socket.send_to(msg.as_bytes(), &addr);
    }

    Ok(())
}

// ======================================
// 补发挂起的文件（后台静默文件传输）
// ======================================
async fn resend_file_background(
    my_id: &str,
    peer_addr: &str,
    file_name: &str,
    file_path: &str,
    file_size: i64,
) -> Result<(), String> {
    println!("[UDP] 正在后台补发文件: {}", file_name);
    // 区分 Android content URI 和普通文件路径
    #[cfg(target_os = "android")]
    let mut file = if file_path.starts_with("content://") {
        println!("[UDP] 检测到 content URI，调用 Android 专用 FD 获取机制");
        let android_file = crate::android_fd::AndroidFile::from_content_uri(file_path)
            .map_err(|e| format!("无法从 Content URI 获取文件: {}", e))?;
        // 将 std::fs::File 转换为 tokio::fs::File
        tokio::fs::File::from_std(android_file.into_file())
    } else {
        tokio::fs::File::open(file_path)
            .await
            .map_err(|e| format!("无法打开文件: {}", e))?
    };

    #[cfg(not(target_os = "android"))]
    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("无法打开文件: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 分钟超时
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let upload_url = format!("http://{}/api/upload", peer_addr);

    // 使用保守的固定分块大小 (50MB) 跑在后台
    let chunk_size = 50 * 1024 * 1024;
    let total_chunks = (file_size + chunk_size - 1) / chunk_size;

    let mut offset = 0;
    let mut chunk_index = 0;

    loop {
        let mut buf = vec![0u8; chunk_size as usize];
        let mut bytes_read = 0;

        while bytes_read < chunk_size as usize {
            use tokio::io::AsyncReadExt;
            let n = file.read(&mut buf[bytes_read..]).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            bytes_read += n;
        }

        if bytes_read == 0 {
            break;
        }
        buf.truncate(bytes_read); // 截断到实际读取长度

        let form = reqwest::multipart::Form::new()
            .text("peer_id", my_id.to_string())
            .text("file_name", file_name.to_string())
            .text("file_size", file_size.to_string())
            .text("chunk_index", chunk_index.to_string())
            .text("chunk_total", total_chunks.to_string())
            .part(
                "chunk",
                reqwest::multipart::Part::bytes(buf)
                    .mime_str("application/octet-stream")
                    .unwrap(),
            );

        let resp = client
            .post(&upload_url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("HTTP 返回错误: {}", resp.status()));
        }

        offset += bytes_read as i64;
        chunk_index += 1;
        if chunk_index % 5 == 0 {
            // 每 5 块打印一次，避免日志刷屏
            println!(
                "[UDP] 文件 {} 补发中: {}/{} MB",
                file_name,
                offset / (1024 * 1024),
                file_size / (1024 * 1024)
            );
        }
    }

    Ok(())
}

// 补发挂起的消息给上线的用户
async fn resend_pending_messages(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    peer_id: &str,
    peer_addr: &str,
    #[allow(unused_variables)] app: Option<AppHandle>,
) -> Result<(), String> {
    println!("[UDP] 检查用户 {} 的挂起消息...", peer_id);

    let pending_messages = crate::db::get_pending_messages(pool, peer_id).await?;

    if pending_messages.is_empty() {
        println!("[UDP] 用户 {} 没有挂起消息", peer_id);
        return Ok(());
    }

    println!(
        "[UDP] 发现 {} 条挂起消息，开始握手...",
        pending_messages.len()
    );

    // 第一步：发送握手请求，询问对方是否准备好接收
    let my_id = crate::db::get_user_id(pool).await?;

    match crate::network::messaging::send_handshake(peer_addr, my_id.clone(), "ready_to_receive")
        .await
    {
        Ok(_) => {
            println!("[UDP] ✓ 握手请求已发送");

            // 等待一段时间让对方处理握手
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // 第二步：补发所有挂起的消息
            let mut msg_ids_to_mark = Vec::new();

            for (msg_id, content, msg_type, _timestamp, file_path, file_size) in pending_messages {
                if msg_type == "text" {
                    // 补发文本消息
                    match crate::network::messaging::send_text_message(
                        peer_addr,
                        my_id.clone(),
                        "System".to_string(),
                        content.clone(),
                    )
                    .await
                    {
                        Ok(_) => {
                            println!("[UDP] ✓ 文本消息 {} 补发成功", msg_id);
                            msg_ids_to_mark.push(msg_id);
                        }
                        Err(e) => {
                            eprintln!("[UDP] ✗ 文本消息 {} 补发失败: {}", msg_id, e);
                        }
                    }

                    // 消息之间稍微延迟，避免过快
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
                // 加入了文件补发逻辑分支
                else if msg_type == "file" {
                    match (file_path.as_ref(), file_size) {
                        (Some(path), Some(size)) if !path.trim().is_empty() => {
                            // 只有路径非空时，才尝试读取文件补发
                            match resend_file_background(&my_id, peer_addr, &content, path, size)
                                .await
                            {
                                Ok(_) => {
                                    println!("[UDP] ✓ 文件消息 {} 补发成功", msg_id);
                                    msg_ids_to_mark.push(msg_id);
                                }
                                Err(e) => {
                                    eprintln!("[UDP] ✗ 文件消息 {} 补发失败: {}", msg_id, e);
                                }
                            }
                        }
                        _ => {
                            // 如果文件路径为空（Web端发送）或信息不全
                            // 我们不能让它一直卡在 pending 状态不停报错
                            eprintln!("[UDP] ⚠ 跳过无法补发的文件消息 {}: 路径缺失(Web端记录或数据异常)。将其移出挂起队列。", msg_id);
                            // 把它加入“待标记”列表，让数据库把它状态改成 sent，
                            // 这样它就再也不会进入补发循环了。
                            msg_ids_to_mark.push(msg_id);
                        }
                    }
                }
            }

            // 标记已发送的消息
            if !msg_ids_to_mark.is_empty() {
                crate::db::mark_messages_as_sent(pool, msg_ids_to_mark).await?;
                #[cfg(feature = "desktop")]
                if let Some(app_handle) = app {
                    let _ = app_handle.emit("messages-resent", peer_id.to_string());
                }
            }
        }
        Err(e) => {
            eprintln!("[UDP] ✗ 握手失败: {}", e);
        }
    }

    Ok(())
}
