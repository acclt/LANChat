package com.lanchat.app

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.annotation.Keep
import java.util.UUID
import org.json.JSONObject

@Keep
object NotificationSyncNative {
    external fun send(data: String)
    external fun pending(requestId: String): Boolean
    external fun complete(requestId: String, success: Boolean, changed: Boolean, reason: String)
}

class LanChatNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        // This gate is JVM-only; an OS-created listener must never initialize native code.
        if (sbn == null || !LanChatForegroundService.notificationSessionReady()) return
        if (sbn.packageName == packageName) return
        val settings = NotificationSyncSettings.read(this)
        if (!settings.optBoolean("push_enabled") || settings.getJSONArray("target_device_ids").length() == 0) return
        if (sbn.packageName !in NotificationSyncSettings.strings(settings.optJSONArray("allowed_packages"))) return
        runCatching {
            // Drop every standard progress notification, including 0% and 100%, before payload/icon/JNI work.
            if (shouldIgnoreProgress(sbn.notification)) return
            val extras = sbn.notification.extras
            val title = limit(extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty(), 256)
            val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
            val text = limit(big.ifBlank { extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty() }, 4096)
            if (title.isBlank() && text.isBlank()) return
            val name = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
            val notification = JSONObject().put("msg_type", "notification").put("event_id", UUID.randomUUID().toString())
                .put("source_device_id", "").put("target_device_id", "").put("package", sbn.packageName)
                .put("app_name", limit(name, 128)).put("title", title).put("text", text)
                .put("notification_key", sbn.key).put("post_time", sbn.postTime)
            NotificationAppIcon.encode(this, sbn.packageName)?.let { notification.put("app_icon", it) }
            if (LanChatForegroundService.notificationSessionReady()) {
                NotificationSyncNative.send(JSONObject().put("notification", notification).put("settings", settings).toString())
            }
        }.onFailure { android.util.Log.w("NotificationSync", "通知采集失败") }
    }
    companion object {
        internal fun shouldIgnoreProgress(notification: Notification): Boolean {
            val extras = notification.extras
            // Test values, not key presence: clearing progress can leave zero/false extras behind.
            return extras.getInt(Notification.EXTRA_PROGRESS_MAX, 0) > 0 ||
                extras.getBoolean(Notification.EXTRA_PROGRESS_INDETERMINATE, false)
        }
    }
    private fun limit(value: String, maximum: Int): String =
        value.substring(0, value.offsetByCodePoints(0, minOf(value.codePointCount(0, value.length), maximum)))
}
