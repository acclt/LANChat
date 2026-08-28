use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_to_tray: Option<bool>,
}

impl Default for Config {
    fn default() -> Self {
        Config { db_path: None, port: None, lang: None, close_to_tray: None }
    }
}

/// 配置文件路径（平台标准配置目录下）
/// Linux:   ~/.config/lanchat/config.json
/// macOS:   ~/Library/Application Support/lanchat/config.json
/// Windows: %APPDATA%\lanchat\config.json
/// Android: /data/data/com.lanchat.app/.config/lanchat/config.json
fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".config"))
        .join("lanchat")
        .join("config.json")
}

/// 读取配置文件，不存在则返回默认值
pub fn read_config() -> Config {
    let path = config_path();
    if !path.exists() {
        return Config::default();
    }
    match std::fs::File::open(&path) {
        Ok(file) => {
            match serde_json::from_reader(file) {
                Ok(cfg) => cfg,
                Err(e) => {
                    eprintln!("[Config] 解析 config.json 失败: {e}，使用默认值");
                    Config::default()
                }
            }
        }
        Err(e) => {
            eprintln!("[Config] 读取 config.json 失败: {e}，使用默认值");
            Config::default()
        }
    }
}

/// 写入配置文件
pub fn write_config(config: &Config) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let file = std::fs::File::create(&tmp_path).map_err(|e| format!("create temp file failed: {e}"))?;
    serde_json::to_writer_pretty(&file, config)
        .map_err(|e| format!("serialize config failed: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("rename config file failed: {e}"))?;
    println!("[Config] config written: {:?}", path);
    Ok(())
}

/// 从存储的路径解析数据库目录
/// 如果路径以 .db 结尾（文件路径），取其父目录
/// 否则直接作为目录处理
pub fn resolve_db_dir(stored: &str) -> PathBuf {
    let p = PathBuf::from(stored);
    if p.extension().map(|e| e == "db").unwrap_or(false) {
        p.parent().unwrap_or(&p).to_path_buf()
    } else {
        p
    }
}

/// 获取平台默认的数据库目录（Web 端）
pub fn get_default_db_dir() -> PathBuf {
    dirs::data_dir()
        .map(|p| p.join("com.lanchat.app"))
        .unwrap_or_else(|| PathBuf::from(".").join("data"))
}

/// 获取平台默认的数据库路径（桌面端，使用 Tauri 的 app_data_dir）
/// 仅在桌面端调用，Web 端用 get_default_db_dir()
pub fn get_default_db_path() -> String {
    get_default_db_dir()
        .join("lanchat.db")
        .to_string_lossy()
        .to_string()
}

/// 从配置读取端口，不存在返回 None
pub fn get_port_from_config() -> Option<u16> {
    read_config().port
}

/// 保存端口到配置
pub fn save_port_to_config(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Port cannot be 0".to_string());
    }
    let mut cfg = read_config();
    cfg.port = Some(port);
    write_config(&cfg)?;
    println!("[Config] 端口配置已保存: {}", port);
    Ok(())
}

/// 从配置读取语言，不存在返回 None
pub fn get_lang_from_config() -> Option<String> {
    read_config().lang
}

/// 保存语言到配置
pub fn save_lang_to_config(lang: &str) -> Result<(), String> {
    if lang != "zh" && lang != "en" {
        return Err(format!("unsupported language: {lang}"));
    }
    let mut cfg = read_config();
    cfg.lang = Some(lang.to_string());
    write_config(&cfg)
}

/// 点击主窗口关闭按钮时是否隐藏到托盘。未配置时默认开启，保持历史行为。
pub fn get_close_to_tray_from_config() -> bool {
    read_config().close_to_tray.unwrap_or(true)
}

/// 保存主窗口关闭按钮行为。
pub fn save_close_to_tray_to_config(enabled: bool) -> Result<(), String> {
    let mut cfg = read_config();
    cfg.close_to_tray = Some(enabled);
    write_config(&cfg)
}
