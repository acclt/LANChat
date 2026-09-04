// 在线用户管理模块
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub id: String, // UUID
    pub name: String,
    pub addr: String,
    pub last_seen: u64,           // Unix 时间戳
    pub is_offline: bool,         // 是否离线
    pub available_memory_mb: u64, // 可用内存（MB）
    #[serde(default)]
    pub notification_push_enabled: bool,
    #[serde(default)]
    pub notification_push_target_device_ids: Vec<String>,
}

// 全局在线用户列表
pub struct PeerManager {
    peers: Arc<RwLock<HashMap<String, Peer>>>, // key 是 UUID
    #[cfg(windows)]
    persistence: RwLock<Option<Arc<crate::peer_persistence::PeerPersistence>>>,
}

impl PeerManager {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(RwLock::new(HashMap::new())),
            #[cfg(windows)]
            persistence: RwLock::new(None),
        }
    }

    pub fn remove_peer(&self, id: &str) {
        let mut peers = self.peers.write().unwrap();
        if peers.remove(id).is_some() {
            println!("[PeerManager] 已从内存中彻底移除用户: {}", id);
        }
    }

    // 从数据库加载历史用户
    pub async fn load_from_db(&self, pool: &sqlx::Pool<sqlx::Sqlite>) -> Result<(), String> {
        println!("[PeerManager] 从数据库加载历史用户...");

        let users = crate::db::get_all_users(pool).await?;

        let mut peers = self.peers.write().unwrap();
        for (id, name, addr, _last_seen, is_offline, available_memory_mb) in users {
            let peer = Peer {
                id: id.clone(),
                name,
                addr,
                last_seen: _last_seen as u64,
                is_offline,
                available_memory_mb,
                notification_push_enabled: false,
                notification_push_target_device_ids: Vec::new(),
            };
            peers.insert(id, peer);
        }

        println!("[PeerManager] 已加载 {} 个历史用户", peers.len());
        Ok(())
    }

    // 添加或更新用户
    pub fn add_or_update(&self, id: String, name: String, addr: String) -> bool {
        self.add_or_update_with_memory(id, name, addr, 0)
    }

    // 添加或更新用户（包含内存信息）
    // 返回 true 表示是新用户或重新上线，false 表示只是更新
    pub fn add_or_update_with_memory(
        &self,
        id: String,
        name: String,
        addr: String,
        available_memory_mb: u64,
    ) -> bool {
        self.observe_discovery(id, name, addr, available_memory_mb)
            .unwrap_or(false)
    }

    pub fn observe_discovery(
        &self,
        id: String,
        name: String,
        addr: String,
        available_memory_mb: u64,
    ) -> Option<bool> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut peers = self.peers.write().unwrap();

        #[cfg(windows)]
        if let Some(store) = self.persistence() {
            if !store.observe(&id, &name, &addr) {
                return None;
            }
        }

        if let Some(peer) = peers.get_mut(&id) {
            // 已存在,更新信息
            let was_offline = peer.is_offline;
            peer.name = name;
            peer.addr = addr;
            peer.last_seen = now;
            peer.is_offline = false;
            peer.available_memory_mb = available_memory_mb;

            // 只在用户重新上线时打印日志
            if was_offline {
                println!(
                    "[PeerManager] 用户重新上线: {} ({}) - 可用内存: {} MB",
                    peer.name, peer.id, available_memory_mb
                );
                return Some(true); // 重新上线，返回 true
            }
            return Some(false); // 只是更新，返回 false
        } else {
            // 新用户
            let peer = Peer {
                id: id.clone(),
                name: name.clone(),
                addr,
                last_seen: now,
                is_offline: false,
                available_memory_mb,
                notification_push_enabled: false,
                notification_push_target_device_ids: Vec::new(),
            };
            println!(
                "[PeerManager] 添加新用户: {} ({}) - 可用内存: {} MB",
                name, id, available_memory_mb
            );
            peers.insert(id, peer);
            return Some(true); // 新用户，返回 true
        }
    }

    pub fn update_notification_presence(
        &self,
        id: &str,
        enabled: bool,
        target_device_ids: Vec<String>,
    ) {
        if let Some(peer) = self.peers.write().unwrap().get_mut(id) {
            peer.notification_push_enabled = enabled;
            peer.notification_push_target_device_ids = target_device_ids;
        }
    }

    pub fn force_mark_offline(&self, id: &str) {
        let mut peers = self.peers.write().unwrap();
        if let Some(peer) = peers.get_mut(id) {
            if !peer.is_offline {
                println!(
                    "[PeerManager] 探测发现用户确已离线: {} ({})",
                    peer.name, peer.id
                );
                peer.is_offline = true;
            }
        }
    }

    // 标记所有用户为"待确认"状态,然后检查哪些用户离线
    pub fn mark_stale_as_offline(&self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut peers = self.peers.write().unwrap();

        // 标记超过 5 秒未见的用户为离线
        for peer in peers.values_mut() {
            #[cfg(not(windows))]
            let time_since_seen = now - peer.last_seen;
            #[cfg(windows)]
            let time_since_seen = if self.persistence().is_some() {
                now.saturating_sub(peer.last_seen)
            } else {
                now - peer.last_seen
            };
            let stale = time_since_seen > 5;
            #[cfg(windows)]
            let stale = self
                .persistence()
                .map_or(stale, |store| store.is_stale(&peer.id));
            if stale && !peer.is_offline {
                println!(
                    "[PeerManager] 用户离线: {} ({}) - {}秒未见",
                    peer.name, peer.id, time_since_seen
                );
                peer.is_offline = true;
            }
        }
    }

    // 获取所有用户（包括离线的）
    pub fn get_all_peers(&self) -> Vec<Peer> {
        // 先标记离线用户
        self.mark_stale_as_offline();

        let peers = self.peers.read().unwrap();
        peers.values().cloned().collect()
    }

    // 获取所有在线用户（过滤掉离线的）
    pub fn get_active_peers(&self) -> Vec<Peer> {
        #[cfg(windows)]
        if self.persistence().is_some() {
            self.mark_stale_as_offline();
        }
        let peers = self.peers.read().unwrap();
        peers.values().filter(|p| !p.is_offline).cloned().collect()
    }

    #[cfg(windows)]
    pub fn enable_windows_persistence(&self, pool: sqlx::Pool<sqlx::Sqlite>) {
        let mut peers = self.peers.write().unwrap();
        let store = Arc::new(crate::peer_persistence::PeerPersistence::new(
            pool,
            &peers.values().cloned().collect::<Vec<_>>(),
        ));
        for peer in peers.values_mut() {
            peer.is_offline = true;
            peer.last_seen = 0;
            peer.available_memory_mb = 0;
        }
        *self.persistence.write().unwrap() = Some(store);
    }

    #[cfg(windows)]
    pub fn persistence(&self) -> Option<Arc<crate::peer_persistence::PeerPersistence>> {
        self.persistence.read().unwrap().clone()
    }

    #[cfg(windows)]
    pub fn begin_presence_session(&self) {
        let mut peers = self.peers.write().unwrap();
        if let Some(store) = self.persistence() {
            store.start_session();
            for peer in peers.values_mut() {
                peer.is_offline = true;
                peer.last_seen = 0;
                peer.available_memory_mb = 0;
            }
        }
    }

    #[cfg(windows)]
    pub(crate) fn begin_profile_delete(
        &self,
        store: &crate::peer_persistence::PeerPersistence,
        id: &str,
    ) {
        let _peers = self.peers.write().unwrap();
        store.suppress(id);
    }

    #[cfg(windows)]
    pub(crate) fn end_profile_delete(
        &self,
        store: &crate::peer_persistence::PeerPersistence,
        id: &str,
        success: bool,
    ) {
        let mut peers = self.peers.write().unwrap();
        if success {
            peers.remove(id);
        }
        store.finish_delete(id, success);
    }

    pub async fn delete_user_and_history(
        self: &Arc<Self>,
        pool: &sqlx::Pool<sqlx::Sqlite>,
        my_id: &str,
        peer_id: &str,
    ) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(store) = self.persistence() {
            return store
                .delete(self.clone(), my_id.to_owned(), peer_id.to_owned())
                .await;
        }
        crate::db::delete_user_and_history(pool, my_id, peer_id).await?;
        self.remove_peer(peer_id);
        Ok(())
    }
}

impl Default for PeerManager {
    fn default() -> Self {
        Self::new()
    }
}
