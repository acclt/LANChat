// src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use lanchat::db;
use lanchat::peers::PeerManager;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short, long)]
    port: Option<u16>,
    #[arg(long)]
    db_path: Option<String>,
}

fn main() {
    let args = Args::parse();

    let cli_port = args.port;
    let cli_db_path = args.db_path;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 当尝试启动第二个实例时，显示已存在的窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init());

    #[cfg(any(target_os = "macos", target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_notification::init());

    builder
        .invoke_handler(tauri::generate_handler![
            lanchat::commands::close_android_fd,
            lanchat::commands::get_my_name,
            lanchat::commands::get_my_id,
            lanchat::commands::update_my_name,
            lanchat::commands::get_peers,
            lanchat::commands::send_message,
            lanchat::commands::get_chat_history,
            lanchat::commands::get_chat_history_with_offset,
            lanchat::commands::send_file,
            lanchat::commands::get_settings,
            lanchat::commands::update_settings,
            lanchat::commands::get_language,
            lanchat::commands::set_language,
            lanchat::commands::get_theme_list,
            lanchat::commands::get_theme_css,
            lanchat::commands::save_current_theme,
            lanchat::commands::get_current_theme,
            lanchat::commands::get_default_download_path,
            lanchat::commands::request_storage_permission,
            lanchat::commands::save_file_message,
            lanchat::commands::open_file_location,
            lanchat::commands::set_android_shared_files,
            lanchat::commands::get_android_shared_files,
            lanchat::commands::clear_android_shared_files,
            lanchat::commands::send_file_from_fd,
            lanchat::commands::share_file_to_other_app,
            lanchat::commands::open_file_in_android,
            lanchat::commands::get_media_token,
            lanchat::commands::read_clipboard_files,
            lanchat::commands::delete_messages,
            lanchat::commands::clear_chat_history,
            lanchat::commands::delete_user_complete,
            lanchat::commands::get_custom_peers,
            lanchat::commands::add_custom_peer,
            lanchat::commands::remove_custom_peer,
            lanchat::commands::show_notification,
            lanchat::commands::request_file,
            lanchat::commands::get_notifications_enabled,
            lanchat::commands::set_notifications_enabled,
            lanchat::commands::open_saf_picker,
            lanchat::commands::start_tray_flash,
            lanchat::commands::stop_tray_flash,
            lanchat::commands::request_permission_on_android,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // 获取主窗口并设置关闭事件处理
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 阻止默认关闭行为
                        api.prevent_close();
                        // 隐藏窗口而不是关闭
                        let _ = window_clone.hide();
                    }
                });
            }

            // 先初始化 DB，再创建托盘（托盘菜单需要读 DB）
            let db_dir = cli_db_path.or_else(|| {
                let cfg = lanchat::config_file::read_config();
                cfg.db_path
                    .as_ref()
                    .map(|p| lanchat::config_file::resolve_db_dir(p).to_string_lossy().to_string())
            });

            let pool = tauri::async_runtime::block_on(async {
                if let Some(dir) = db_dir {
                    lanchat::db::init_db_standalone(Some(std::path::PathBuf::from(dir))).await.expect("DB error")
                } else {
                    db::init_db(&handle).await.expect("DB error")
                }
            });

            let my_name = tauri::async_runtime::block_on(async {
                db::get_username(&pool).await.unwrap_or_else(|_| "Unknown".into())
            });

            let my_id = tauri::async_runtime::block_on(async {
                db::get_user_id(&pool).await.expect("无法获取或生成用户 ID")
            });

            let port: u16 = cli_port.unwrap_or_else(|| lanchat::config_file::get_port_from_config().unwrap_or(8888));

            let notif_enabled = tauri::async_runtime::block_on(async {
                lanchat::db::get_notifications_enabled(&pool).await
            });

            handle.manage(db::DbState { pool: pool.clone() });
            handle.manage(lanchat::commands::TrayFlashState::default());
            println!("[Main] 我的用户名: {}", my_name);
            println!("[Main] 我的 ID: {}", my_id);
            println!("[Main] 服务端口: {}", port);

            // 读取语言设置用于托盘菜单
            let tray_lang = lanchat::config_file::get_lang_from_config()
                .or_else(|| std::env::var("LANG").ok().map(|l| if l.starts_with("zh") { "zh".to_string() } else { "en".to_string() }))
                .unwrap_or_else(|| "zh".to_string());
            let (show_text, notif_text, quit_text) = if tray_lang == "en" {
                ("Show Window", "Enable Notifications", "Quit")
            } else {
                ("显示窗口", "开启通知", "退出")
            };

            // 创建托盘菜单（现在 DB 已就绪）
            let show_item = MenuItem::with_id(app, "show", show_text, true, None::<&str>)?;
            let toggle_notif = tauri::menu::CheckMenuItem::with_id(
                app, "toggle_notif", notif_text, true, notif_enabled, None::<&str>,
            )?;
            let toggle_notif_clone = toggle_notif.clone();
            let notif_enabled_atomic = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(notif_enabled));
            let quit_item = MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &toggle_notif, &quit_item])?;

            // 注册托盘菜单项到状态（供 set_language 热更新）
            #[cfg(all(feature = "desktop", not(target_os = "android")))]
            handle.manage(lanchat::commands::TrayMenuItems {
                show_item: show_item.clone(),
                toggle_notif: toggle_notif.clone(),
                quit_item: quit_item.clone(),
            });

            // 创建托盘图标
            let _tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LANChat")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("open-latest-unread", ());
                    }
                    "toggle_notif" => {
                        let current = notif_enabled_atomic.load(std::sync::atomic::Ordering::Relaxed);
                        let new_state = !current;
                        notif_enabled_atomic.store(new_state, std::sync::atomic::Ordering::Relaxed);
                        let _ = toggle_notif_clone.set_checked(new_state);
                        // 持久化到 DB
                        let pool = {
                            let state = app.state::<lanchat::db::DbState>();
                            state.pool.clone()
                        };
                        tauri::async_runtime::block_on(async {
                            let _ = lanchat::db::set_notifications_enabled(&pool, new_state).await;
                        });
                        // 通知 JS 刷新缓存
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("notifications-changed", new_state);
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } = event
                    {
                        if button == tauri::tray::MouseButton::Left
                            && button_state == tauri::tray::MouseButtonState::Up
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let _ = app.emit("open-latest-unread", ());
                        }
                    }
                })
                .build(app)?;

            // 创建 PeerManager 并启动服务（DB 已就绪，无需再次 block_on）
            let peer_manager = Arc::new(PeerManager::new());
            let _ = tauri::async_runtime::block_on(async {
                if let Err(e) = peer_manager.load_from_db(&pool).await {
                    eprintln!("[Main] 加载历史用户失败: {}", e);
                }
                Ok::<(), ()>(())
            });
            handle.manage(lanchat::commands::PeerState {
                manager: peer_manager.clone(),
            });
            handle.manage(lanchat::commands::AndroidShareState::new());

            // 在 Tokio runtime 上下文中启动后台线程
            tauri::async_runtime::block_on(async {
                let h1 = handle.clone();
                let id1 = my_id.clone();
                let name1 = my_name.clone();
                let peer_manager_clone = peer_manager.clone();
                let pool_for_discovery = pool.clone();
                tokio::spawn(async move {
                    println!("[Main] 开启监听线程...");
                    lanchat::network::discovery::start_listening(
                        port, id1, name1, Some(h1), peer_manager_clone, pool_for_discovery,
                    )
                    .await;
                });

                let id2 = my_id.clone();
                let pool2 = pool.clone();
                tokio::spawn(async move {
                    println!("[Main] 开启广播线程...");
                    lanchat::network::discovery::start_announcing(port, id2, pool2).await;
                });

                let pool_clone = pool.clone();
                let peer_manager_clone = peer_manager.clone();
                let handle_clone = handle.clone();
                tokio::spawn(async move {
                    println!("[Main] 启动 HTTP 服务器在端口 {}...", port);
                    lanchat::web_server::start_server(
                        port, port, pool_clone, peer_manager_clone, Some(handle_clone),
                    )
                    .await;
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
