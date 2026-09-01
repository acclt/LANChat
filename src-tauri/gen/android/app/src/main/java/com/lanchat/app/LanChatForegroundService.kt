package com.lanchat.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.Keep
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

class LanChatForegroundService : Service() {
    private external fun nativeStartCore(appDataDir: String): String
    private external fun nativeStopCore(): String
    private external fun nativeForceStopCore(): String
    private external fun nativeGetCoreStatus(): String
    private external fun nativeRegisterServiceEventSink()
    private external fun nativeUnregisterServiceEventSink(): String

    private val worker = Executors.newSingleThreadExecutor()
    private val shutdownWorker = Executors.newSingleThreadExecutor()
    private val nativeStopWorker = Executors.newCachedThreadPool()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val exiting = AtomicBoolean(false)
    private val coreStartRequested = AtomicBoolean(false)
    private var acceptedSessionToken: String? = null
    private var jniReadyForSession = false
    private var platformSessionInitialized = false

    private lateinit var notificationManager: NotificationManager
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var wifiManager: WifiManager
    private lateinit var powerManager: PowerManager
    private var multicastLock: WifiManager.MulticastLock? = null
    private var transferWakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        AndroidDownloadStore.initialize(applicationContext)
        notificationManager = getSystemService(NotificationManager::class.java)
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        wifiManager = applicationContext.getSystemService(WifiManager::class.java)
        powerManager = getSystemService(PowerManager::class.java)
        createNotificationChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_SESSION -> acceptVisibleSessionOrStop(intent, startId, retry = false)
            ACTION_RETRY -> acceptVisibleSessionOrStop(intent, startId, retry = true)
            ACTION_STOP_SESSION -> {
                val token = intent.getStringExtra(EXTRA_SESSION_TOKEN)
                if (token != null && token == acceptedSessionToken && jniReadyForSession) {
                    invalidatePersistedSession(this)
                    beginExit()
                } else {
                    rejectUnexpectedStart(startId, "无有效会话的停止请求")
                }
            }
            else -> rejectUnexpectedStart(startId, "系统重建或缺少显式启动 Action")
        }
        return serviceStartMode()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        // stopWithTask=true 时系统通常不会调用本回调；保留为 OEM 防御路径。
        invalidatePersistedSession(this)
        beginExit()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // stopWithTask=true 会先清除 started Service 状态，再进入此兜底清理。
        // commit 是同步且很小的写入，必须先于任何异步 native 停止工作。
        invalidatePersistedSession(this)
        beginExit()
        super.onDestroy()
    }

    private fun acceptVisibleSessionOrStop(intent: Intent, startId: Int, retry: Boolean) {
        val token = intent.getStringExtra(EXTRA_SESSION_TOKEN)
        if (!isValidVisibleSessionRequest(this, token, nativeReadyInProcess)) {
            rejectUnexpectedStart(startId, "会话令牌无效或 Rust 尚未由可见 Activity 加载")
            return
        }

        acceptedSessionToken = token
        jniReadyForSession = true
        if (!platformSessionInitialized) {
            platformSessionInitialized = true
            startInForeground(buildServiceNotification("正在启动后台接收服务"))
            registerWifiObserver()
            nativeRegisterServiceEventSink()
        }
        startCoreAsync(force = retry)
    }

    private fun rejectUnexpectedStart(startId: Int, reason: String) {
        notificationSessionActive = false
        SyncedNotificationPublisher.clear()
        invalidatePersistedSession(this)
        acceptedSessionToken = null
        jniReadyForSession = false
        exiting.set(true)
        android.util.Log.w(TAG, "拒绝 Service-only 启动：$reason")
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        if (::notificationManager.isInitialized) {
            notificationManager.cancel(SERVICE_NOTIFICATION_ID)
        }
        stopSelfResult(startId)
    }

    private fun startCoreAsync(force: Boolean = false) {
        if (exiting.get() || !jniReadyForSession || acceptedSessionToken == null) return
        if (!force && !coreStartRequested.compareAndSet(false, true)) return
        if (force) coreStartRequested.set(true)
        updateServiceNotification("正在启动后台接收服务")
        worker.execute {
            val response = runCatching { JSONObject(nativeStartCore(applicationInfo.dataDir)) }
                .getOrElse { JSONObject().put("ok", false).put("error", it.message ?: "JNI 启动失败") }
            mainHandler.post { applyCoreResult(response) }
        }
    }

    private fun applyCoreResult(response: JSONObject) {
        val status = response.optJSONObject("status")
        notificationSessionActive = status?.optString("state") == "RUNNING" && jniReadyForSession && !exiting.get()
        if (!notificationSessionActive) SyncedNotificationPublisher.clear()
        when (status?.optString("state")) {
            "RUNNING" -> {
                updateServiceNotification("已准备好发送和接收消息与文件")
                updateMulticastLock()
            }
            "STARTING" -> updateServiceNotification("正在启动后台接收服务")
            "ERROR" -> {
                releaseMulticastLock()
                updateServiceNotification("后台接收发生异常，点击查看")
                postErrorNotification(status.optString("last_error_message", response.optString("error")))
            }
            "STOPPED" -> releaseMulticastLock()
        }
    }

    @Keep
    fun onNativeCoreEvent(eventJson: String) {
        mainHandler.post {
            if (exiting.get()) return@post
            runCatching {
                val envelope = JSONObject(eventJson)
                val event = envelope.getJSONObject("event")
                val type = event.getString("type")
                val payload = event.optJSONObject("payload") ?: JSONObject()
                when (type) {
                    "notification_received" -> SyncedNotificationPublisher.receive(this, payload)
                    "core_state_changed", "core_error" -> applyCoreResult(
                        JSONObject().put("ok", type != "core_error").put("status", payload)
                    )
                    "file_transfer_started", "file_transfer_progress" -> {
                        touchTransferWakeLock()
                    }
                    "file_transfer_completed" -> {
                        releaseTransferWakeLock()
                        withShortWakeLock {
                            if (payload.optString("from_id").isNotBlank() &&
                                !envelope.optBoolean("ui_visible") &&
                                envelope.optBoolean("notifications_enabled", true)
                            ) {
                                postDataNotification(type, payload)
                            }
                        }
                    }
                    "message_received", "file_offer_received" -> {
                        withShortWakeLock {
                            if (payload.optString("from_id").isNotBlank() &&
                                !envelope.optBoolean("ui_visible") &&
                                envelope.optBoolean("notifications_enabled", true)
                            ) {
                                postDataNotification(type, payload)
                            }
                        }
                    }
                }
            }.onFailure { error ->
                android.util.Log.e(TAG, "AndroidEventBridge 事件处理失败", error)
            }
        }
    }

    private fun beginExit() {
        notificationSessionActive = false
        SyncedNotificationPublisher.clear()
        invalidatePersistedSession(this)
        if (!exiting.compareAndSet(false, true)) return
        coreStartRequested.set(false)
        if (!jniReadyForSession) {
            finishPlatformExit()
            return
        }
        shutdownWorker.execute {
            val firstStop = invokeNativeStopWithTimeout(force = false, STOP_CALL_TIMEOUT_MS)
            val finalStop = if (isVerifiedStopResponse(firstStop)) {
                firstStop
            } else {
                android.util.Log.w(TAG, "正常停止未满足后置条件，执行强制取消兜底: $firstStop")
                invokeNativeStopWithTimeout(force = true, FORCE_STOP_CALL_TIMEOUT_MS)
            }
            val sinkReleased = runCatching {
                val response = JSONObject(nativeUnregisterServiceEventSink())
                response.optBoolean("ok") && response.optInt("subscriber_count", -1) == 0
            }
                .onFailure { android.util.Log.e(TAG, "注销 AndroidEventBridge 失败", it) }
                .getOrDefault(false)
            val verified = isVerifiedStopResponse(finalStop) && sinkReleased
            if (verified) {
                android.util.Log.i(TAG, "核心停止后置条件已验证: $finalStop")
            } else {
                android.util.Log.e(TAG, "核心停止未能验证为完整退出: $finalStop")
            }
            worker.shutdownNow()
            nativeStopWorker.shutdownNow()
            mainHandler.post {
                unregisterWifiObserver()
                releaseTransferWakeLock()
                releaseMulticastLock()
                stopForeground(STOP_FOREGROUND_REMOVE)
                notificationManager.cancel(SERVICE_NOTIFICATION_ID)
                stopSelf()
            }
            shutdownWorker.shutdown()
        }
    }

    private fun finishPlatformExit() {
        unregisterWifiObserver()
        releaseTransferWakeLock()
        releaseMulticastLock()
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        if (::notificationManager.isInitialized) {
            notificationManager.cancel(SERVICE_NOTIFICATION_ID)
        }
        stopSelf()
    }

    private fun invokeNativeStopWithTimeout(force: Boolean, timeoutMs: Long): JSONObject {
        val future = nativeStopWorker.submit<String> {
            if (force) nativeForceStopCore() else nativeStopCore()
        }
        return try {
            JSONObject(future.get(timeoutMs, TimeUnit.MILLISECONDS))
        } catch (error: TimeoutException) {
            future.cancel(true)
            JSONObject()
                .put("ok", false)
                .put("error_code", if (force) "FORCE_STOP_JNI_TIMEOUT" else "STOP_JNI_TIMEOUT")
                .put("error_message", "等待 Rust Core 停止超时")
        } catch (error: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error_code", "STOP_JNI_FAILED")
                .put("error_message", error.message ?: "JNI 停止失败")
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        notificationManager.createNotificationChannel(
            NotificationChannel(
                SERVICE_CHANNEL,
                "LQ Chat 后台接收",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "显示当前后台接收服务状态"
                setSound(null, null)
                setShowBadge(false)
            },
        )
        notificationManager.createNotificationChannel(
            NotificationChannel(
                MESSAGE_CHANNEL,
                "LQ Chat 消息和文件",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "新消息、文件完成和服务错误"
                enableVibration(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
    }

    private fun startInForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification)
        }
    }

    private fun servicePendingIntent(peerId: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (!peerId.isNullOrBlank()) putExtra(EXTRA_PEER_ID, peerId)
        }
        return PendingIntent.getActivity(
            this,
            peerId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun buildServiceNotification(text: String): Notification =
        NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("LQ Chat")
            .setContentText(text)
            .setContentIntent(servicePendingIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    private fun updateServiceNotification(text: String) {
        notificationManager.notify(SERVICE_NOTIFICATION_ID, buildServiceNotification(text))
    }

    private fun postDataNotification(type: String, payload: JSONObject) {
        val peerId = payload.optString("from_id")
        val fromName = payload.optString("from_name", "局域网设备")
        val body = when (type) {
            "file_offer_received" -> "请求发送文件：${payload.optString("file_name", payload.optString("content"))}"
            "file_transfer_completed" -> "文件接收完成：${payload.optString("file_name", payload.optString("content"))}"
            else -> payload.optString("content", "收到一条新消息")
        }
        val idSeed = payload.optLong("id", System.currentTimeMillis())
        val notificationId = notificationIdFor(idSeed)
        val notification = NotificationCompat.Builder(this, MESSAGE_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(fromName)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(servicePendingIntent(peerId))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        runCatching { notificationManager.notify(notificationId, notification) }
            .onFailure { android.util.Log.w(TAG, "消息通知发送失败", it) }
    }

    private fun postErrorNotification(message: String) {
        val notification = NotificationCompat.Builder(this, MESSAGE_CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("LQ Chat 后台接收发生异常")
            .setContentText(message.ifBlank { "点击打开并重试" })
            .setContentIntent(servicePendingIntent())
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()
        runCatching { notificationManager.notify(ERROR_NOTIFICATION_ID, notification) }
    }

    private fun registerWifiObserver() {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = updateMulticastLock()
            override fun onLost(network: Network) = updateMulticastLock()
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                updateMulticastLock()
        }
        networkCallback = callback
        runCatching {
            connectivityManager.registerNetworkCallback(
                NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
                callback,
            )
        }
    }

    private fun unregisterWifiObserver() {
        networkCallback?.let { callback -> runCatching { connectivityManager.unregisterNetworkCallback(callback) } }
        networkCallback = null
    }

    private fun isWifiAvailable(): Boolean {
        val active = connectivityManager.activeNetwork ?: return false
        return wifiManager.isWifiEnabled &&
            connectivityManager.getNetworkCapabilities(active)
                ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }

    private fun updateMulticastLock() {
        mainHandler.post {
            if (!jniReadyForSession || acceptedSessionToken == null) {
                releaseMulticastLock()
                return@post
            }
            val running = runCatching {
                JSONObject(nativeGetCoreStatus()).optJSONObject("status")?.optString("state") == "RUNNING"
            }.getOrDefault(false)
            if (!exiting.get() && running && isWifiAvailable()) acquireMulticastLock()
            else releaseMulticastLock()
        }
    }

    private fun acquireMulticastLock() {
        if (multicastLock?.isHeld == true) return
        multicastLock = (multicastLock ?: wifiManager.createMulticastLock("LANChat:Discovery").apply {
            setReferenceCounted(false)
        }).also { lock ->
            runCatching { lock.acquire() }
                .onSuccess { android.util.Log.i(TAG, "MulticastLock acquired") }
                .onFailure { android.util.Log.e(TAG, "MulticastLock acquire failed", it) }
        }
    }

    private fun releaseMulticastLock() {
        multicastLock?.let { lock ->
            if (lock.isHeld) runCatching { lock.release() }
            android.util.Log.i(TAG, "MulticastLock released")
        }
        multicastLock = null
    }

    private inline fun withShortWakeLock(block: () -> Unit) {
        val lock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LANChat:EventProcessing")
            .apply { setReferenceCounted(false) }
        try {
            lock.acquire(SHORT_WAKE_TIMEOUT_MS)
            block()
        } finally {
            if (lock.isHeld) runCatching { lock.release() }
        }
    }

    private fun touchTransferWakeLock() {
        releaseTransferWakeLock()
        transferWakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "LANChat:ActiveTransfer",
        ).apply {
            setReferenceCounted(false)
            acquire(TRANSFER_WAKE_TIMEOUT_MS)
        }
    }

    private fun releaseTransferWakeLock() {
        transferWakeLock?.let { if (it.isHeld) runCatching { it.release() } }
        transferWakeLock = null
    }

    companion object {
        const val ACTION_START_SESSION = "com.lanchat.app.action.START_USER_SESSION"
        const val ACTION_STOP_SESSION = "com.lanchat.app.action.STOP_SESSION"
        const val ACTION_RETRY = "com.lanchat.app.action.RETRY_BACKGROUND"
        const val EXTRA_PEER_ID = "lanchat_peer_id"
        internal const val EXTRA_SESSION_TOKEN = "lanchat_session_token"
        private const val SESSION_PREFS = "lanchat_runtime_session"
        private const val SESSION_ACTIVE = "active"
        private const val SESSION_TOKEN = "token"
        @Volatile
        private var nativeReadyInProcess = false
        @Volatile private var notificationSessionActive = false
        fun notificationSessionReady(): Boolean = nativeReadyInProcess && notificationSessionActive
        private const val TAG = "LanChatService"
        private const val SERVICE_CHANNEL = "lanchat_background_service"
        // Android 渠道的重要性一旦创建就无法由应用升级。使用新 ID 将旧版
        // IMPORTANCE_DEFAULT 渠道迁移为能显示顶部横幅的高重要性渠道。
        internal const val MESSAGE_CHANNEL = "lanchat_messages_v2"
        private const val SERVICE_NOTIFICATION_ID = 4100
        private const val ERROR_NOTIFICATION_ID = 9100
        private const val MESSAGE_NOTIFICATION_BASE = 10000
        private const val SHORT_WAKE_TIMEOUT_MS = 15_000L
        private const val TRANSFER_WAKE_TIMEOUT_MS = 120_000L
        private const val STOP_CALL_TIMEOUT_MS = 15_000L
        private const val FORCE_STOP_CALL_TIMEOUT_MS = 6_000L

        fun startVisibleUserSession(context: Context) {
            nativeReadyInProcess = true
            val token = UUID.randomUUID().toString()
            persistSession(context, token)
            ContextCompat.startForegroundService(
                context,
                Intent(context, LanChatForegroundService::class.java).apply {
                    action = ACTION_START_SESSION
                    putExtra(EXTRA_SESSION_TOKEN, token)
                },
            )
        }

        fun retryVisibleUserSession(context: Context) {
            nativeReadyInProcess = true
            val token = currentSessionToken(context) ?: UUID.randomUUID().toString().also {
                persistSession(context, it)
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, LanChatForegroundService::class.java).apply {
                    action = ACTION_RETRY
                    putExtra(EXTRA_SESSION_TOKEN, token)
                },
            )
        }

        fun stopVisibleUserSession(context: Context) {
            val token = currentSessionToken(context)
            invalidatePersistedSession(context)
            context.startService(
                Intent(context, LanChatForegroundService::class.java).apply {
                    action = ACTION_STOP_SESSION
                    putExtra(EXTRA_SESSION_TOKEN, token)
                },
            )
        }

        internal fun persistSession(context: Context, token: String): Boolean =
            context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(SESSION_ACTIVE, true)
                .putString(SESSION_TOKEN, token)
                .commit()

        internal fun invalidatePersistedSession(context: Context): Boolean =
            context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(SESSION_ACTIVE, false)
                .remove(SESSION_TOKEN)
                .commit()

        internal fun currentSessionToken(context: Context): String? {
            val prefs = context.getSharedPreferences(SESSION_PREFS, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(SESSION_ACTIVE, false)) return null
            return prefs.getString(SESSION_TOKEN, null)?.takeIf { it.isNotBlank() }
        }

        internal fun isValidVisibleSessionRequest(
            context: Context,
            token: String?,
            nativeReady: Boolean,
        ): Boolean = nativeReady && token != null && token == currentSessionToken(context)

        internal fun resetProcessNativeReadyForTest() {
            nativeReadyInProcess = false
        }

        internal fun serviceStartMode(): Int = START_NOT_STICKY

        internal fun isVerifiedStopResponse(response: JSONObject): Boolean {
            val status = response.optJSONObject("status")
            return response.optBoolean("ok") &&
                status?.optString("state") == "STOPPED" &&
                response.optBoolean("tasks_stopped") &&
                response.optBoolean("ports_released") &&
                response.optBoolean("resources_released")
        }

        internal fun notificationIdFor(idSeed: Long): Int =
            MESSAGE_NOTIFICATION_BASE + ((idSeed.hashCode() and Int.MAX_VALUE) % 8000)
    }
}
