// 消息发送和接收模块
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[cfg(feature = "desktop")]
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMessage {
    pub msg_type: String,  // "text"
    pub from_id: String,   // 发送者 UUID
    pub from_name: String, // 发送者名字
    pub content: String,   // 消息内容
    pub timestamp: u64,    // Unix 时间戳
}

// 握手协议消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeMessage {
    pub protocol: String, // "handshake"
    pub action: String,   // "ready_to_receive" 或 "ack"
    pub from_id: String,  // 发送者 UUID
}

// 发送握手消息（询问对方是否准备好接收）
pub async fn send_handshake(peer_addr: &str, from_id: String, action: &str) -> Result<(), String> {
    let handshake = HandshakeMessage {
        protocol: "handshake".to_string(),
        action: action.to_string(),
        from_id,
    };

    let json = serde_json::to_string(&handshake).map_err(|e| format!("序列化失败: {}", e))?;

    // 尝试通过 WebSocket 发送
    let ws_url = format!("ws://{}/ws", peer_addr);

    match tokio_tungstenite::connect_async(&ws_url).await {
        Ok((mut ws_stream, _)) => {
            use futures_util::SinkExt;
            use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

            ws_stream
                .send(WsMessage::Text(json))
                .await
                .map_err(|e| format!("发送握手失败: {}", e))?;

            let _ = ws_stream.close(None).await;
            Ok(())
        }
        Err(e) => {
            eprintln!("[Messaging] 握手 WebSocket 连接失败: {}, 尝试 TCP", e);
            send_handshake_via_tcp(peer_addr, handshake).await
        }
    }
}

// 通过 TCP 发送握手消息
async fn send_handshake_via_tcp(
    peer_addr: &str,
    handshake: HandshakeMessage,
) -> Result<(), String> {
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(peer_addr)
        .await
        .map_err(|e| format!("TCP 连接失败: {}", e))?;

    let json = serde_json::to_string(&handshake).map_err(|e| format!("序列化失败: {}", e))?;

    let len = json.len() as u32;
    stream
        .write_all(&len.to_be_bytes())
        .await
        .map_err(|e| format!("发送长度失败: {}", e))?;

    stream
        .write_all(json.as_bytes())
        .await
        .map_err(|e| format!("发送握手失败: {}", e))?;

    Ok(())
}

// 发送文本消息
pub async fn send_text_message(
    peer_addr: &str,
    from_id: String,
    from_name: String,
    content: String,
) -> Result<(), String> {
    println!("[Messaging] 正在连接到 {}...", peer_addr);

    // 构造消息
    let message = TextMessage {
        msg_type: "text".to_string(),
        from_id,
        from_name,
        content,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };

    // 序列化为 JSON
    let json = serde_json::to_string(&message).map_err(|e| format!("序列化失败: {}", e))?;

    // 尝试通过 WebSocket 发送
    let ws_url = format!("ws://{}/ws", peer_addr);

    match tokio_tungstenite::connect_async(&ws_url).await {
        Ok((mut ws_stream, _)) => {
            println!("[Messaging] WebSocket 连接成功");

            use futures_util::SinkExt;
            use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

            ws_stream
                .send(WsMessage::Text(json))
                .await
                .map_err(|e| format!("发送失败: {}", e))?;

            // 优雅地关闭连接
            let _ = ws_stream.close(None).await;

            println!("[Messaging] 消息发送成功");
            Ok(())
        }
        Err(e) => {
            eprintln!("[Messaging] WebSocket 连接失败: {}, 尝试 TCP", e);
            // 回退到 TCP
            send_via_tcp(peer_addr, message).await
        }
    }
}

// 通过 TCP 发送(回退方案)
async fn send_via_tcp(peer_addr: &str, message: TextMessage) -> Result<(), String> {
    use tokio::net::TcpStream;

    let mut stream = TcpStream::connect(peer_addr)
        .await
        .map_err(|e| format!("TCP 连接失败: {}", e))?;

    let json = serde_json::to_string(&message).map_err(|e| format!("序列化失败: {}", e))?;

    // 发送消息长度(4字节)
    let len = json.len() as u32;
    stream
        .write_all(&len.to_be_bytes())
        .await
        .map_err(|e| format!("发送长度失败: {}", e))?;

    // 发送消息内容
    stream
        .write_all(json.as_bytes())
        .await
        .map_err(|e| format!("发送消息失败: {}", e))?;

    println!("[Messaging] TCP 消息发送成功");
    Ok(())
}

// 启动消息接收服务器
pub async fn start_message_server(
    port: u16,
    db_pool: sqlx::Pool<sqlx::Sqlite>,
    #[cfg(feature = "desktop")] app_handle: Option<tauri::AppHandle>,
) {
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .expect("无法绑定消息服务器端口");

    println!("[Messaging] 消息服务器启动在端口 {}", port);

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                println!("[Messaging] 收到来自 {} 的连接", addr);

                let pool = db_pool.clone();
                #[cfg(feature = "desktop")]
                let app = app_handle.clone();

                tokio::spawn(async move {
                    #[cfg(feature = "desktop")]
                    let result = handle_message_connection(stream, pool, app).await;

                    #[cfg(feature = "web")]
                    let result = handle_message_connection(stream, pool).await;

                    if let Err(e) = result {
                        eprintln!("[Messaging] 处理消息失败: {}", e);
                    }
                });
            }
            Err(e) => {
                eprintln!("[Messaging] 接受连接失败: {}", e);
            }
        }
    }
}

// 处理单个消息连接 - 桌面端版本
#[cfg(all(feature = "desktop", not(feature = "web")))]
async fn handle_message_connection(
    mut stream: tokio::net::TcpStream,
    db_pool: sqlx::Pool<sqlx::Sqlite>,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(), String> {
    // 读取消息长度(4字节)
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .map_err(|e| format!("读取长度失败: {}", e))?;

    let len = u32::from_be_bytes(len_bytes) as usize;

    if len > 1024 * 1024 {
        return Err("消息过大".to_string());
    }

    // 读取消息内容
    let mut buffer = vec![0u8; len];
    stream
        .read_exact(&mut buffer)
        .await
        .map_err(|e| format!("读取消息失败: {}", e))?;

    // 解析 JSON
    let json_str = String::from_utf8(buffer).map_err(|e| format!("UTF-8 解析失败: {}", e))?;

    // 首先尝试解析为握手消息
    if let Ok(handshake) = serde_json::from_str::<HandshakeMessage>(&json_str) {
        println!("[Messaging] 收到握手消息: action={}", handshake.action);

        if handshake.action == "ready_to_receive" {
            // 对方询问我们是否准备好接收，发送 ack 确认
            let my_id = crate::db::get_user_id(&db_pool).await.unwrap_or_default();
            let ack = HandshakeMessage {
                protocol: "handshake".to_string(),
                action: "ack".to_string(),
                from_id: my_id,
            };

            if let Ok(ack_json) = serde_json::to_string(&ack) {
                let len = ack_json.len() as u32;
                let _ = stream.write_all(&len.to_be_bytes()).await;
                let _ = stream.write_all(ack_json.as_bytes()).await;
                println!("[Messaging] 已发送握手 ack");
            }
        }
        return Ok(());
    }

    // 否则尝试解析为文本消息
    let message: TextMessage =
        serde_json::from_str(&json_str).map_err(|e| format!("JSON 解析失败: {}", e))?;

    println!(
        "[Messaging] 收到消息: {} 说: {}",
        message.from_name, message.content
    );

    // 保存到数据库
    crate::db::save_network_message(
        &db_pool,
        &message.from_id,
        &message.content,
        &message.msg_type,
        message.timestamp,
    )
    .await?;

    // 发送事件通知前端
    if let Some(app) = app_handle {
        let _ = app.emit(
            "new-message",
            serde_json::json!({
                "from_id": message.from_id,
                "from_name": message.from_name,
                "content": message.content,
                "timestamp": message.timestamp,
            }),
        );
    }

    Ok(())
}

// Web 端的消息处理 - 不带 AppHandle
#[cfg(all(feature = "web", not(feature = "desktop")))]
async fn handle_message_connection(
    mut stream: tokio::net::TcpStream,
    db_pool: sqlx::Pool<sqlx::Sqlite>,
) -> Result<(), String> {
    // 读取消息长度(4字节)
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .map_err(|e| format!("读取长度失败: {}", e))?;

    let len = u32::from_be_bytes(len_bytes) as usize;

    if len > 1024 * 1024 {
        return Err("消息过大".to_string());
    }

    // 读取消息内容
    let mut buffer = vec![0u8; len];
    stream
        .read_exact(&mut buffer)
        .await
        .map_err(|e| format!("读取消息失败: {}", e))?;

    // 解析 JSON
    let json_str = String::from_utf8(buffer).map_err(|e| format!("UTF-8 解析失败: {}", e))?;

    // 首先尝试解析为握手消息
    if let Ok(handshake) = serde_json::from_str::<HandshakeMessage>(&json_str) {
        println!("[Messaging] 收到握手消息: action={}", handshake.action);

        if handshake.action == "ready_to_receive" {
            // 对方询问我们是否准备好接收，发送 ack 确认
            let my_id = crate::db::get_user_id(&db_pool).await.unwrap_or_default();
            let ack = HandshakeMessage {
                protocol: "handshake".to_string(),
                action: "ack".to_string(),
                from_id: my_id,
            };

            if let Ok(ack_json) = serde_json::to_string(&ack) {
                let len = ack_json.len() as u32;
                let _ = stream.write_all(&len.to_be_bytes()).await;
                let _ = stream.write_all(ack_json.as_bytes()).await;
                println!("[Messaging] 已发送握手 ack");
            }
        }
        return Ok(());
    }

    // 否则尝试解析为文本消息
    let message: TextMessage =
        serde_json::from_str(&json_str).map_err(|e| format!("JSON 解析失败: {}", e))?;

    println!(
        "[Messaging] 收到消息: {} 说: {}",
        message.from_name, message.content
    );

    // 保存到数据库
    crate::db::save_network_message(
        &db_pool,
        &message.from_id,
        &message.content,
        &message.msg_type,
        message.timestamp,
    )
    .await?;

    // Web 端暂时只保存,不通知前端(前端会轮询)

    Ok(())
}

// 查询聊天历史（支持分页）
pub async fn get_chat_history(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    peer_id: &str,
    limit: i32,
) -> Result<Vec<serde_json::Value>, String> {
    get_chat_history_with_offset(pool, peer_id, limit, 0).await
}

// 查询聊天历史（带偏移量，用于懒加载）
pub async fn get_chat_history_with_offset(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    peer_id: &str,
    limit: i32,
    offset: i32,
) -> Result<Vec<serde_json::Value>, String> {
    // 底层 SQL 交给 db.rs 处理，这里只负责序列化 JSON
    let messages = crate::db::get_chat_history_with_offset(pool, peer_id, limit, offset).await?;

    // 转换为 MessageResponse 并序列化为 JSON
    let responses: Vec<serde_json::Value> = messages
        .into_iter()
        .map(|msg| {
            let response = crate::models::MessageResponse::from(msg);
            serde_json::to_value(response).unwrap_or(serde_json::json!({}))
        })
        .collect();

    Ok(responses)
}
