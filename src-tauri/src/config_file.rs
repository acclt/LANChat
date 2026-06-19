use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { db_path: None }
    }
}

/// 配置文件路径 ~/.config/lanchat/config.json
fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
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
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let file = std::fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
    serde_json::to_writer_pretty(&file, config)
        .map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("重命名配置文件失败: {e}"))?;
    println!("[Config] 配置已写入: {:?}", path);
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
