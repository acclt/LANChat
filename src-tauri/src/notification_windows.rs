//! Windows-only publisher; chat/file Toast behavior remains unchanged.
use crate::notification_sync::{self, Notification};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};

struct Entry {
    message: Notification,
    tag: String,
    _toast: ToastNotification,
}
struct Publisher {
    generation: u64,
    group: String,
    next: u64,
    entries: VecDeque<Entry>,
}
impl Default for Publisher {
    fn default() -> Self {
        Self {
            generation: 0,
            group: uuid::Uuid::new_v4().simple().to_string()[..16].into(),
            next: 0,
            entries: VecDeque::new(),
        }
    }
}
fn publisher() -> &'static Mutex<Publisher> {
    static STATE: OnceLock<Mutex<Publisher>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Publisher::default()))
}
pub fn clear() {
    *publisher().lock().unwrap() = Publisher::default();
}
fn xml_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c == '\n' || *c == '\r' || *c == '\t' || *c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
// Toast images need a local file. This bounded image-only cache contains no notification text.
fn toast_xml(
    message: &Notification,
    source: &str,
    image: Option<&Path>,
    record_id: &str,
) -> String {
    let image = image
        .and_then(|p| reqwest::Url::from_file_path(p).ok())
        .map(|uri| {
            format!(
                "<image src=\"{}\" hint-removeMargin=\"true\"/>",
                xml_text(uri.as_str())
            )
        })
        .unwrap_or_default();
    let time = chrono::DateTime::from_timestamp_millis(message.post_time)
        .map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default();
    format!(concat!("<toast launch=\"--notification-activation history:{}:{}\"><visual><binding template=\"ToastGeneric\"><group>",
        "<subgroup hint-weight=\"1\">{}<text hint-style=\"caption\" hint-align=\"center\" hint-wrap=\"true\" hint-maxLines=\"2\">{}</text></subgroup>",
        "<subgroup hint-weight=\"4\"><text hint-style=\"body\" hint-wrap=\"true\" hint-maxLines=\"2\">{}</text>",
        "<text hint-wrap=\"true\" hint-maxLines=\"4\">{}</text><text hint-style=\"captionSubtle\" hint-align=\"right\">{}</text></subgroup>",
        "</group><text placement=\"attribution\">来自 {}</text></binding></visual></toast>"),
        xml_text(record_id), xml_text(&message.source_device_id), image, xml_text(&message.app_name), xml_text(&message.title), xml_text(&message.text), time, xml_text(source))
}
fn publish(
    message: &Notification,
    source: &str,
    record_id: &str,
    image: Option<&Path>,
) -> Result<bool, String> {
    let status = crate::core_runtime::CoreRuntime::global().status();
    if status.state != crate::core_events::CoreState::Running {
        return Err("stopped".into());
    }
    static IDENTITY: OnceLock<Result<(), String>> = OnceLock::new();
    IDENTITY
        .get_or_init(crate::commands::ensure_windows_notification_identity)
        .clone()?;
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("com.lanchat.app"))
            .map_err(|_| "notifier_unavailable")?;
    if notifier.Setting().map_err(|_| "permission_unknown")? != NotificationSetting::Enabled {
        return Err("permission_blocked".into());
    }
    let mut state = publisher().lock().unwrap();
    if state.generation != status.generation {
        *state = Publisher {
            generation: status.generation,
            ..Publisher::default()
        };
    }
    let index = state
        .entries
        .iter()
        .position(|e| e.message.key() == message.key());
    if let Some(i) = index {
        if state.entries[i].message.same_content(message) {
            let e = state.entries.remove(i).unwrap();
            state.entries.push_back(e);
            return Ok(false);
        }
    }
    let tag = if let Some(i) = index {
        state.entries[i].tag.clone()
    } else {
        state.next = state.next.checked_add(1).ok_or("tag_exhausted")?;
        let tag = state.next.to_string();
        if tag.len() > 16 {
            return Err("tag_exhausted".into());
        }
        tag
    };
    let result = (|| -> windows::core::Result<ToastNotification> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(message, source, image, record_id)))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        let activation_record = record_id.to_string();
        let activation_source = message.source_device_id.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            use tauri::{Emitter, Manager};
            if let Some(handle) = crate::CURRENT_APP_HANDLE
                .get()
                .and_then(|slot| slot.read().ok())
                .and_then(|slot| slot.clone())
            {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = handle.emit(
                    "synced-notification-tapped",
                    serde_json::json!({
                        "recordId":activation_record,"sourceDeviceId":activation_source
                    }),
                );
            }
            Ok(())
        }))?;
        toast.SetGroup(&HSTRING::from(&state.group))?;
        toast.SetTag(&HSTRING::from(&tag))?;
        notifier.Show(&toast)?;
        Ok(toast)
    })();
    let toast = result.map_err(|_| "system_notification_failed")?;
    if let Some(i) = index {
        state.entries.remove(i);
    }
    state.entries.push_back(Entry {
        message: message.clone(),
        tag,
        _toast: toast,
    });
    while state.entries.len() > 512 {
        state.entries.pop_front();
    }
    Ok(true)
}
pub async fn receive(payload: &serde_json::Value, pool: &sqlx::Pool<sqlx::Sqlite>) {
    let id = payload["request_id"].as_str().unwrap_or("");
    if !notification_sync::pending_active(id) {
        return;
    }
    let result = if notification_sync::receive_enabled(pool).await
        && notification_sync::pending_active(id)
    {
        match serde_json::from_value::<Notification>(payload["notification"].clone()) {
            Ok(message) => {
                let image = crate::notification_history::cached_icon_path(
                    pool,
                    message.app_icon.as_deref(),
                )
                .await;
                publish(
                    &message,
                    payload["source_name"]
                        .as_str()
                        .unwrap_or(&message.source_device_id),
                    payload["history_record_id"].as_str().unwrap_or(""),
                    image.as_deref(),
                )
            }
            Err(_) => Err("invalid".into()),
        }
    } else {
        Err("disabled".into())
    };
    let (success, changed, reason) = match result {
        Ok(changed) => (true, changed, None),
        Err(reason) => (false, false, Some(reason)),
    };
    notification_sync::complete(id, success, changed, reason);
}

#[cfg(test)]
mod tests {
    #[test]
    fn notification_content_cannot_inject_toast_xml() {
        assert_eq!(super::xml_text("<&\"'\u{0}>"), "&lt;&amp;&quot;&apos;&gt;");
    }
}
