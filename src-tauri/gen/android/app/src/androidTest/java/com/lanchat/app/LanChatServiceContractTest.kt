package com.lanchat.app

import android.content.ComponentName
import android.content.Context
import android.content.pm.ServiceInfo
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class LanChatServiceContractTest {

    @Test
    fun safDownloadBridgeKeepsJniEntryPoint() {
        assertNotNull(
            AndroidDownloadStore::class.java.getDeclaredMethod(
                "exportReceivedFile",
                String::class.java,
                String::class.java,
                String::class.java,
            )
        )
        assertNotNull(MainActivity::class.java.getDeclaredMethod("launchDownloadDirectoryPicker"))
    }
    @Test
    fun serviceManifestKeepsSingleProcessRecoveryContract() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        @Suppress("DEPRECATION")
        val info = context.packageManager.getServiceInfo(
            ComponentName(context, LanChatForegroundService::class.java),
            0,
        )

        assertFalse(info.exported)
        assertTrue(info.flags and ServiceInfo.FLAG_STOP_WITH_TASK == 0)
        assertTrue(
            info.foregroundServiceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE != 0,
        )
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            assertTrue(
                info.foregroundServiceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING != 0,
            )
        }

        @Suppress("DEPRECATION")
        val packageInfo = context.packageManager.getPackageInfo(
            context.packageName,
            android.content.pm.PackageManager.GET_SERVICES,
        )
        assertEquals(
            1,
            packageInfo.services.orEmpty().count {
                it.name == LanChatForegroundService::class.java.name
            },
        )
    }

    @Test
    fun serviceReturnsStickyAndDeclaresDefensiveExitCallbacks() {
        assertEquals(android.app.Service.START_STICKY, LanChatForegroundService.serviceStartMode())
        assertNotNull(
            LanChatForegroundService::class.java.getDeclaredMethod(
                "onTaskRemoved",
                Intent::class.java,
            ),
        )
        assertNotNull(LanChatForegroundService::class.java.getDeclaredMethod("onDestroy"))
    }

    @Test
    fun serviceOnlyStartWithoutVisibleSessionIsRejectedBeforeNativeAccess() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        LanChatForegroundService.invalidatePersistedSession(context)
        LanChatForegroundService.resetProcessNativeReadyForTest()

        assertFalse(
            LanChatForegroundService.isValidVisibleSessionRequest(
                context,
                token = null,
                nativeReady = false,
            ),
        )

        val staleToken = "stale-session-token"
        LanChatForegroundService.persistSession(context, staleToken)
        assertFalse(
            LanChatForegroundService.isValidVisibleSessionRequest(
                context,
                token = staleToken,
                nativeReady = false,
            ),
        )
        assertFalse(
            LanChatForegroundService.isValidVisibleSessionRequest(
                context,
                token = null,
                nativeReady = true,
            ),
        )
    }

    @Test
    fun visibleSessionTokenIsSingleProcessAndExitInvalidationIsIdempotent() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val token = "visible-session-token"
        assertTrue(LanChatForegroundService.persistSession(context, token))
        assertTrue(
            LanChatForegroundService.isValidVisibleSessionRequest(
                context,
                token = token,
                nativeReady = true,
            ),
        )
        assertTrue(LanChatForegroundService.invalidatePersistedSession(context))
        assertTrue(LanChatForegroundService.invalidatePersistedSession(context))
        assertEquals(null, LanChatForegroundService.currentSessionToken(context))
        assertFalse(
            LanChatForegroundService.isValidVisibleSessionRequest(
                context,
                token = token,
                nativeReady = true,
            ),
        )
    }

    @Test
    fun jniStopMethodsReturnStructuredJsonStrings() {
        val normal = LanChatForegroundService::class.java.getDeclaredMethod("nativeStopCore")
        val forced = LanChatForegroundService::class.java.getDeclaredMethod("nativeForceStopCore")
        val unregister = LanChatForegroundService::class.java.getDeclaredMethod(
            "nativeUnregisterServiceEventSink",
        )
        assertEquals(String::class.java, normal.returnType)
        assertEquals(String::class.java, forced.returnType)
        assertEquals(String::class.java, unregister.returnType)

        val verified = JSONObject()
            .put("ok", true)
            .put("status", JSONObject().put("state", "STOPPED"))
            .put("tasks_stopped", true)
            .put("ports_released", true)
            .put("resources_released", true)
        assertTrue(LanChatForegroundService.isVerifiedStopResponse(verified))
        verified.put("ports_released", false)
        assertFalse(LanChatForegroundService.isVerifiedStopResponse(verified))
    }

    @Test
    fun notificationIdsAreDeterministicAndSeparateFromServiceNotification() {
        val first = LanChatForegroundService.notificationIdFor(42L)
        val duplicate = LanChatForegroundService.notificationIdFor(42L)
        val different = LanChatForegroundService.notificationIdFor(43L)
        assertEquals(first, duplicate)
        assertNotEquals(first, different)
        assertTrue(first in 10_000 until 18_000)
        assertNotEquals(4_100, first)
        assertEquals("lanchat_messages_v2", LanChatForegroundService.MESSAGE_CHANNEL)
    }

    @Test
    fun foregroundServicePermissionsArePackaged() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val packageInfo = context.packageManager.getPackageInfo(
            context.packageName,
            android.content.pm.PackageManager.GET_PERMISSIONS,
        )
        val permissions = packageInfo.requestedPermissions?.toSet().orEmpty()
        assertTrue("android.permission.FOREGROUND_SERVICE" in permissions)
        assertTrue("android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" in permissions)
        assertTrue("android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" in permissions)
        assertTrue("android.permission.CHANGE_WIFI_MULTICAST_STATE" in permissions)
        assertTrue("android.permission.POST_NOTIFICATIONS" in permissions)
        assertTrue("android.permission.RECEIVE_BOOT_COMPLETED" in permissions)
    }

    @Test
    fun backgroundPolicySeparatesPreferencesFromCurrentStopBoundary() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val saved = BackgroundRuntimeSettings.save(context, JSONObject()
            .put("keep_running", true).put("start_on_boot", true).put("exclude_from_recents", true))
        assertTrue(saved.getBoolean("keep_running"))
        assertTrue(BackgroundRuntimeSettings.mayRecover(context))
        BackgroundRuntimeSettings.stopCurrentSession(context)
        assertTrue(BackgroundRuntimeSettings.mayStartOnBoot(context))
        assertFalse(BackgroundRuntimeSettings.mayRecover(context))
        BackgroundRuntimeSettings.beginBootSession(context, 123L)
        assertTrue(BackgroundRuntimeSettings.mayRecover(context))
    }
}
