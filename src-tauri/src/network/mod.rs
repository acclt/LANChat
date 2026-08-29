pub mod discovery;
pub mod messaging;

/// LANChat 的 HTTP 请求只面向局域网对端，不能继承系统或进程代理。
/// 文本 WebSocket 本来就是直连；文件与设置探测也必须保持相同语义。
pub fn lan_http_client(timeout: Option<std::time::Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().no_proxy();
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| format!("创建局域网 HTTP 客户端失败: {error}"))
}
