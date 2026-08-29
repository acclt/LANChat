use std::sync::atomic::{AtomicBool, Ordering};

static UI_VISIBLE: AtomicBool = AtomicBool::new(false);

pub fn set_ui_visible(visible: bool) {
    UI_VISIBLE.store(visible, Ordering::Release);
}

pub fn ui_visible() -> bool {
    UI_VISIBLE.load(Ordering::Acquire)
}

#[cfg(target_os = "android")]
mod android {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use jni::objects::{GlobalRef, JObject, JString, JValue};
    use jni::sys::{jboolean, jstring};
    use jni::{JNIEnv, JavaVM};

    use crate::core_runtime::CoreRuntime;

    struct ServiceSink {
        cancelled: Arc<AtomicBool>,
        thread: JoinHandle<()>,
    }

    static SERVICE_SINK: OnceLock<Mutex<Option<ServiceSink>>> = OnceLock::new();

    fn sink_slot() -> &'static Mutex<Option<ServiceSink>> {
        SERVICE_SINK.get_or_init(|| Mutex::new(None))
    }

    fn json_string(env: &mut JNIEnv<'_>, value: serde_json::Value) -> jstring {
        env.new_string(value.to_string())
            .map(|value| value.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    fn status_json(result: Result<crate::core_events::CoreStatus, String>) -> serde_json::Value {
        match result {
            Ok(status) => serde_json::json!({"ok": true, "status": status}),
            Err(error) => serde_json::json!({
                "ok": false,
                "status": CoreRuntime::global().status(),
                "error": error,
            }),
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeStartCore(
        mut env: JNIEnv,
        _service: JObject,
        app_data_dir: JString,
    ) -> jstring {
        let path = match env.get_string(&app_data_dir) {
            Ok(value) => PathBuf::from(value.to_string_lossy().into_owned()),
            Err(error) => {
                return json_string(
                    &mut env,
                    serde_json::json!({"ok": false, "error": error.to_string()}),
                )
            }
        };
        json_string(&mut env, status_json(CoreRuntime::global().start(path)))
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeStopCore(
        mut env: JNIEnv,
        _service: JObject,
    ) -> jstring {
        crate::stop_ui_event_bridge();
        json_string(
            &mut env,
            serde_json::to_value(CoreRuntime::global().stop_report()).unwrap_or_else(
                |error| serde_json::json!({"ok": false, "error": error.to_string()}),
            ),
        )
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeForceStopCore(
        mut env: JNIEnv,
        _service: JObject,
    ) -> jstring {
        crate::stop_ui_event_bridge();
        json_string(
            &mut env,
            serde_json::to_value(CoreRuntime::global().force_stop_report()).unwrap_or_else(
                |error| serde_json::json!({"ok": false, "error": error.to_string()}),
            ),
        )
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeGetCoreStatus(
        mut env: JNIEnv,
        _service: JObject,
    ) -> jstring {
        json_string(
            &mut env,
            serde_json::json!({"ok": true, "status": CoreRuntime::global().status()}),
        )
    }

    fn deliver_event(vm: &JavaVM, service: &GlobalRef, json: String) -> Result<(), String> {
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| error.to_string())?;
        let json = env.new_string(json).map_err(|error| error.to_string())?;
        let json_object = JObject::from(json);
        env.call_method(
            service.as_obj(),
            "onNativeCoreEvent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&json_object)],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn stop_sink() {
        let existing = sink_slot().lock().ok().and_then(|mut slot| slot.take());
        if let Some(existing) = existing {
            existing.cancelled.store(true, Ordering::Release);
            CoreRuntime::global().event_bus().publish(
                crate::core_events::CoreEvent::CoreStateChanged(CoreRuntime::global().status()),
            );
            let _ = existing.thread.join();
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeRegisterServiceEventSink(
        env: JNIEnv,
        service: JObject,
    ) {
        stop_sink();
        let Ok(vm) = env.get_java_vm() else {
            return;
        };
        let Ok(service) = env.new_global_ref(service) else {
            return;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let thread_cancelled = cancelled.clone();
        let mut receiver = CoreRuntime::global().event_bus().subscribe();
        let thread = std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            else {
                return;
            };
            runtime.block_on(async move {
                while !thread_cancelled.load(Ordering::Acquire) {
                    let event = tokio::select! {
                        event = receiver.recv() => event.ok(),
                        _ = tokio::time::sleep(Duration::from_millis(250)) => None,
                    };
                    let Some(event) = event else {
                        continue;
                    };
                    let notifications_enabled = match CoreRuntime::global().shared_resources() {
                        Some((pool, _)) => crate::db::get_notifications_enabled(&pool).await,
                        None => false,
                    };
                    let json = serde_json::json!({
                        "event": event,
                        "ui_visible": super::ui_visible(),
                        "notifications_enabled": notifications_enabled,
                    });
                    if let Err(error) = deliver_event(&vm, &service, json.to_string()) {
                        eprintln!("[AndroidEventBridge] JNI 回调失败: {error}");
                    }
                }
            });
        });
        if let Ok(mut slot) = sink_slot().lock() {
            *slot = Some(ServiceSink { cancelled, thread });
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_LanChatForegroundService_nativeUnregisterServiceEventSink(
        mut env: JNIEnv,
        _service: JObject,
    ) -> jstring {
        stop_sink();
        let subscriber_count = CoreRuntime::global().event_bus().subscriber_count();
        json_string(
            &mut env,
            serde_json::json!({
                "ok": subscriber_count == 0,
                "subscriber_count": subscriber_count,
            }),
        )
    }

    #[no_mangle]
    pub extern "system" fn Java_com_lanchat_app_MainActivity_nativeSetUiVisibility(
        _env: JNIEnv,
        _activity: JObject,
        visible: jboolean,
    ) {
        let visible = visible != 0;
        super::set_ui_visible(visible);
        if visible {
            crate::start_ui_event_bridge();
        }
    }
}
