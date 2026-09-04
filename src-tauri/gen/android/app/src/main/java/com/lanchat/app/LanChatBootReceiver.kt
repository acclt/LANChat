package com.lanchat.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class LanChatBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_USER_UNLOCKED) return
        if (!BackgroundRuntimeSettings.mayStartOnBoot(context)) return

        if (action == Intent.ACTION_BOOT_COMPLETED) {
            BackgroundRuntimeSettings.beginBootSession(context, System.currentTimeMillis())
        }
        LanChatForegroundService.startRecoverySession(context, "boot:$action")
    }
}
