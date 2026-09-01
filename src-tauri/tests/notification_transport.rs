use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use lanchat::{
    core_events::CoreEvent,
    core_runtime::CoreRuntime,
    notification_sync::{self, Notification, Settings},
    peers::PeerManager,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::Message;

fn notification() -> Notification {
    Notification {
        msg_type: "notification".into(),
        event_id: "integration-event".into(),
        source_device_id: "source".into(),
        target_device_id: "target".into(),
        package: "lanchat.integration".into(),
        app_name: "Integration".into(),
        app_icon: Some(
            base64::engine::general_purpose::STANDARD.encode(include_bytes!("../icons/32x32.png")),
        ),
        title: "Synthetic test".into(),
        text: "No personal data".into(),
        notification_key: "key".into(),
        post_time: 1,
    }
}

#[test]
fn fanout_is_independent_and_inbound_notifications_never_enter_chat_or_broadcast() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let dir = std::env::temp_dir().join(format!(
        "lanchat-notification-test-{}",
        uuid::Uuid::new_v4()
    ));
    let pool = runtime
        .block_on(lanchat::db::init_db_with_path(dir.clone()))
        .unwrap();
    let peers = Arc::new(PeerManager::new());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let core = CoreRuntime::global();
    core.prepare(pool.clone(), peers.clone());
    core.start_with_port(dir, Some(port)).unwrap();
    runtime.block_on(async {
        let fast = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        peers.add_or_update("fast".into(),"Fast".into(),fast.local_addr().unwrap().to_string());
        peers.add_or_update("slow".into(),"Slow".into(),slow.local_addr().unwrap().to_string());
        peers.add_or_update("offline".into(),"Offline".into(),"127.0.0.1:1".into());
        peers.force_mark_offline("offline");
        let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = fast.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request:Value = serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(request["target_device_id"],"fast");
            assert!(lanchat::notification_icon::decode(request["app_icon"].as_str().unwrap()).is_some());
            // A reply for a different target must not complete this request.
            ws.send(Message::Text(json!({"msg_type":"notification_result","event_id":request["event_id"],"target_device_id":"wrong","status":"failure"}).to_string())).await.unwrap();
            ws.send(Message::Text(json!({"msg_type":"notification_result","event_id":request["event_id"],"target_device_id":"fast","status":"success"}).to_string())).await.unwrap();
            let _ = arrived_tx.send(());
            assert!(tokio::time::timeout(Duration::from_millis(150),fast.accept()).await.is_err(),"duplicate target retried");
        });
        let slow_server = tokio::spawn(async move {
            let (stream, _) = slow.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.next().await.unwrap().unwrap();
            tokio::time::sleep(Duration::from_secs(6)).await;
        });
        let send = tokio::spawn(notification_sync::send(notification(),Settings {push_enabled:true,target_device_ids:vec!["slow".into(),"fast".into(),"offline".into(),"fast".into()],..Settings::default()}));
        tokio::time::timeout(Duration::from_secs(2),arrived_rx).await.unwrap().unwrap();
        send.await.unwrap().unwrap(); server.await.unwrap(); slow_server.abort();
        let records = lanchat::notification_history::query(&pool, Default::default()).await.unwrap().records;
        assert_eq!(records.len(),3);
        assert_eq!(records.iter().find(|r|r.peer_id=="fast").unwrap().status,"success");
        assert_eq!(records.iter().find(|r|r.peer_id=="slow").unwrap().status,"timeout");
        assert_eq!(records.iter().find(|r|r.peer_id=="offline").unwrap().status,"offline");

        let local = lanchat::db::get_user_id(&pool).await.unwrap();
        let (mut observer,_) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws")).await.unwrap();
        let mut events=core.event_bus().subscribe();
        let mut incoming=notification(); incoming.target_device_id=local.clone();
        let response_task = tokio::spawn(async move {
            loop {
                match events.recv().await.unwrap() {
                    CoreEvent::NotificationReceived(v) => {notification_sync::complete(v["request_id"].as_str().unwrap(),true,true,None);break;}
                    CoreEvent::MessageReceived(_) => panic!("notification became a chat event"),
                    _=>{}
                }
            }
        });
        lanchat::network::messaging::send_notification_once(&format!("127.0.0.1:{port}"),&incoming).await.unwrap();
        response_task.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200),observer.next()).await.is_err(),"notification/reply leaked to unrelated WS");
        let count: i64=sqlx::query_scalar("SELECT COUNT(*) FROM messages").fetch_one(&pool).await.unwrap(); assert_eq!(count,0);
        incoming.target_device_id="wrong-local".into();
        assert!(tokio::time::timeout(Duration::from_millis(250), lanchat::network::messaging::send_notification_once(&format!("127.0.0.1:{port}"),&incoming)).await.is_err());
        let _=observer.close(None).await;
    });
    assert!(core.stop_report().ok);
    notification_sync::on_state_event(&CoreEvent::CoreStateChanged(core.status()));
    let persisted = runtime
        .block_on(lanchat::notification_history::query(
            &pool,
            Default::default(),
        ))
        .unwrap();
    assert_eq!(persisted.records.len(), 4);
    assert!(!notification_sync::pending_active("integration-event"));
}
