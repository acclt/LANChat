use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoreState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreStatus {
    pub state: CoreState,
    pub generation: u64,
    pub port: Option<u16>,
    pub started_at: Option<i64>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
}

impl Default for CoreStatus {
    fn default() -> Self {
        Self {
            state: CoreState::Stopped,
            generation: 0,
            port: None,
            started_at: None,
            last_error_code: None,
            last_error_message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum CoreEvent {
    CoreStateChanged(CoreStatus),
    PeerDiscovered(serde_json::Value),
    MessageReceived(serde_json::Value),
    FileOfferReceived(serde_json::Value),
    FileTransferStarted(serde_json::Value),
    FileTransferProgress(serde_json::Value),
    FileTransferCompleted(serde_json::Value),
    MessagesResent { peer_id: String },
    CoreError(CoreStatus),
}

impl CoreEvent {
    pub fn ui_event(&self) -> Option<(&'static str, serde_json::Value)> {
        match self {
            Self::CoreStateChanged(status) | Self::CoreError(status) => {
                serde_json::to_value(status)
                    .ok()
                    .map(|value| ("core-state-changed", value))
            }
            Self::PeerDiscovered(value) => Some(("new-peer", value.clone())),
            Self::FileTransferProgress(value)
                if value
                    .get("msg_type")
                    .and_then(|kind| kind.as_str())
                    .is_none() =>
            {
                Some(("upload_progress", value.clone()))
            }
            Self::MessageReceived(value)
            | Self::FileOfferReceived(value)
            | Self::FileTransferStarted(value)
            | Self::FileTransferProgress(value)
            | Self::FileTransferCompleted(value) => Some(("new-message", value.clone())),
            Self::MessagesResent { peer_id } => Some((
                "messages-resent",
                serde_json::Value::String(peer_id.clone()),
            )),
        }
    }
}

#[derive(Clone)]
pub struct CoreEventBus {
    sender: broadcast::Sender<CoreEvent>,
}

impl Default for CoreEventBus {
    fn default() -> Self {
        Self::new(512)
    }
}

impl CoreEventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.sender.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    pub fn publish(&self, event: CoreEvent) {
        let _ = self.sender.send(event);
    }

    pub fn publish_message(&self, payload: serde_json::Value) {
        let msg_type = payload.get("msg_type").and_then(|value| value.as_str());
        let file_status = payload.get("file_status").and_then(|value| value.as_str());
        let event = match (msg_type, file_status) {
            (Some("file"), Some("offered")) => CoreEvent::FileOfferReceived(payload),
            (Some("file"), Some("downloading")) => CoreEvent::FileTransferStarted(payload),
            (Some("file"), Some("accepted" | "received" | "completed" | "save_failed")) => {
                CoreEvent::FileTransferCompleted(payload)
            }
            (Some("file_download_progress" | "file_progress"), _) => {
                CoreEvent::FileTransferProgress(payload)
            }
            (Some("file_offer"), _) => CoreEvent::FileOfferReceived(payload),
            (Some("file_transfer_start" | "file_start"), _) => {
                CoreEvent::FileTransferStarted(payload)
            }
            _ => CoreEvent::MessageReceived(payload),
        };
        self.publish(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribers_receive_committed_message_events_once() {
        let bus = CoreEventBus::default();
        let mut receiver = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 1);
        bus.publish_message(serde_json::json!({"msg_type": "text", "id": 7}));
        let event = receiver.recv().await.unwrap();
        assert!(matches!(event, CoreEvent::MessageReceived(_)));
        assert!(receiver.try_recv().is_err());
        drop(receiver);
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn save_failed_file_is_still_reported_as_completed_transfer() {
        let bus = CoreEventBus::default();
        let mut receiver = bus.subscribe();
        bus.publish_message(serde_json::json!({
            "msg_type": "file",
            "file_status": "save_failed",
            "file_path": "fd:received-file"
        }));
        let event = receiver.recv().await.unwrap();
        assert!(matches!(event, CoreEvent::FileTransferCompleted(_)));
    }
}
