package com.lanchat.app

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.os.Process
import android.service.notification.StatusBarNotification
import android.widget.RemoteViews
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationSyncContractTest {
    @Test fun syncedNotificationLaunchUsesExplicitImmutableMetadata() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val notification = JSONObject().put("source_device_id", "phone-a")
            .put("package", "example.messages").put("notification_key", "stable-key")
        val payload = JSONObject().put("history_record_id", "record-123")
        val intent = SyncedNotificationPublisher.launchIntent(context, payload, notification)
        assertEquals(MainActivity::class.java.name, intent.component?.className)
        assertEquals("record-123", intent.getStringExtra(SyncedNotificationPublisher.EXTRA_HISTORY_RECORD_ID))
        assertEquals("phone-a", intent.getStringExtra(SyncedNotificationPublisher.EXTRA_SOURCE_DEVICE_ID))
        assertEquals("example.messages", intent.getStringExtra(SyncedNotificationPublisher.EXTRA_NOTIFICATION_PACKAGE))
        assertEquals("stable-key", intent.getStringExtra(SyncedNotificationPublisher.EXTRA_NOTIFICATION_KEY))
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
        assertNull(intent.data)
    }

    @Test fun bulkAllowedReplacementIsASnapshotAndInvalidReplacementKeepsOldValue() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val previous = NotificationSyncSettings.read(context)
        try {
            val apps = JSONObject(NotificationSyncSettings.command(context, JSONObject().put("action", "apps").toString()))
                .getJSONArray("installed_snapshot")
            if (apps.length() == 0) return
            val chosen = JSONArray().put(apps.getString(0))
            val replace = JSONObject().put("action", "replace_allowed")
                .put("payload", JSONObject().put("packages", chosen))
            val result = JSONObject(NotificationSyncSettings.command(context, replace.toString()))
            assertFalse(result.has("error"))
            assertEquals(setOf(chosen.getString(0)), NotificationSyncSettings.strings(NotificationSyncSettings.read(context).getJSONArray("allowed_packages")))
            replace.put("payload", JSONObject().put("packages", JSONArray().put("not.installed.invalid")))
            val failed = JSONObject(NotificationSyncSettings.command(context, replace.toString()))
            assertTrue(failed.has("error"))
            assertEquals(setOf(chosen.getString(0)), NotificationSyncSettings.strings(NotificationSyncSettings.read(context).getJSONArray("allowed_packages")))
        } finally {
            NotificationSyncSettings.command(context, JSONObject().put("action", "save").put("settings", previous).toString())
        }
    }

    @Suppress("DEPRECATION")
    @Test fun standardProgressIsIgnoredAtStartDuringAndAtOneHundredPercent() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val builder = Notification.Builder(context).setSmallIcon(android.R.drawable.stat_sys_download)
        for (progress in intArrayOf(0, 35, 100)) {
            val notification = builder.setProgress(100, progress, false).build()
            assertTrue("Progress $progress must not be forwarded", LanChatNotificationListener.shouldIgnoreProgress(notification))
        }
        val indeterminate = builder.setProgress(0, 0, true).build()
        assertTrue(LanChatNotificationListener.shouldIgnoreProgress(indeterminate))
    }

    @Suppress("DEPRECATION")
    @Test fun clearingProgressOnTheSameBuilderAllowsCompletionAndFailure() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val builder = Notification.Builder(context).setSmallIcon(android.R.drawable.stat_sys_download)
        for (result in listOf("下载完成", "下载失败")) {
            assertTrue(LanChatNotificationListener.shouldIgnoreProgress(builder.setProgress(100, 35, false).build()))
            val notification = builder.setProgress(0, 0, false).setContentText(result).build()
            assertFalse("Cleared progress must not block $result", LanChatNotificationListener.shouldIgnoreProgress(notification))
        }
    }

    @Suppress("DEPRECATION")
    @Test fun ordinaryOngoingAndPercentageTextAreNotProgressSignals() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertFalse(LanChatNotificationListener.shouldIgnoreProgress(Notification()))
        val builder = Notification.Builder(context).setSmallIcon(android.R.drawable.stat_sys_download)
        assertFalse(LanChatNotificationListener.shouldIgnoreProgress(builder.setContentText("普通消息").build()))
        assertFalse(LanChatNotificationListener.shouldIgnoreProgress(builder.setContentText("下载到 35% 了").build()))
        assertFalse(LanChatNotificationListener.shouldIgnoreProgress(builder.setOngoing(true).build()))
    }

    @Test fun appIconIsBoundedAndCustomNotificationLayoutsInflate() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val icon = NotificationAppIcon.encode(context, context.packageName)
        assertNotNull(icon)
        assertTrue(icon!!.length <= 10924)
        val bitmap = NotificationAppIcon.decode(icon)
        assertNotNull(bitmap)
        assertTrue(bitmap!!.width <= 96 && bitmap.height <= 96)
        assertNull(NotificationAppIcon.decode("https://example.invalid/icon.png"))
        for (layout in intArrayOf(R.layout.notification_sync_compact, R.layout.notification_sync_expanded)) {
            val remote = RemoteViews(context.packageName, layout).apply {
                setImageViewBitmap(R.id.sync_icon, bitmap)
                setTextViewText(R.id.sync_app, "示例应用")
                setTextViewText(R.id.sync_title, "标题")
                setTextViewText(R.id.sync_text, "正文")
                setTextViewText(R.id.sync_time, "11:17")
            }
            val view = remote.apply(context, null)
            assertEquals("示例应用", view.findViewById<TextView>(R.id.sync_app).text.toString())
            assertEquals("11:17", view.findViewById<TextView>(R.id.sync_time).text.toString())
        }
    }
    @Test fun coldListenerIgnoresAllowedNotificationWithoutAnyNativeLibrary() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val previous = NotificationSyncSettings.read(context)
        try {
            NotificationSyncSettings.command(context, JSONObject().put("action", "save").put("settings",
                JSONObject().put("push_enabled", true).put("receive_enabled", false)
                    .put("allowed_packages", JSONArray(listOf("example.allowed")))
                    .put("target_device_ids", JSONArray(listOf("phone-b", "pc-c")))).toString())
            LanChatForegroundService.resetProcessNativeReadyForTest()
            assertFalse(LanChatForegroundService.notificationSessionReady())
            @Suppress("DEPRECATION")
            val posted = StatusBarNotification("example.allowed", "example.allowed", 42, null,
                0, 0, 0, Notification(), Process.myUserHandle(), System.currentTimeMillis())
            // An unattached listener has no Context and no loaded JNI. Only the JVM gate can safely return.
            LanChatNotificationListener().onNotificationPosted(posted)
            val saved = NotificationSyncSettings.read(context)
            assertTrue(saved.getBoolean("push_enabled"))
            assertEquals(setOf("phone-b", "pc-c"), NotificationSyncSettings.strings(saved.getJSONArray("target_device_ids")))
        } finally {
            NotificationSyncSettings.command(context, JSONObject().put("action", "save").put("settings", previous).toString())
        }
    }
}
