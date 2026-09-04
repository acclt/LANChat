package com.lanchat.app

import android.content.Context
import org.json.JSONObject

/** Persistent background policy and the current boot/session stop boundary. */
object BackgroundRuntimeSettings {
    private const val PREFS = "background_runtime"
    private const val KEEP_RUNNING = "keep_running"
    private const val START_ON_BOOT = "start_on_boot"
    private const val EXCLUDE_FROM_RECENTS = "exclude_from_recents"
    private const val USER_STOPPED = "user_stopped"
    private const val BOOT_ID = "boot_id"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized fun read(context: Context): JSONObject {
        val p = prefs(context)
        return JSONObject()
            .put("keep_running", p.getBoolean(KEEP_RUNNING, false))
            .put("start_on_boot", p.getBoolean(START_ON_BOOT, false))
            .put("exclude_from_recents", p.getBoolean(EXCLUDE_FROM_RECENTS, false))
            .put("user_stopped", p.getBoolean(USER_STOPPED, false))
            .put("boot_id", p.getLong(BOOT_ID, 0L))
    }

    @Synchronized fun save(context: Context, input: JSONObject): JSONObject {
        val p = prefs(context)
        val keepRunning = input.optBoolean("keep_running", p.getBoolean(KEEP_RUNNING, false))
        val startOnBoot = input.optBoolean("start_on_boot", p.getBoolean(START_ON_BOOT, false))
        val excludeFromRecents = input.optBoolean(
            "exclude_from_recents",
            p.getBoolean(EXCLUDE_FROM_RECENTS, false),
        )
        check(p.edit()
            .putBoolean(KEEP_RUNNING, keepRunning)
            .putBoolean(START_ON_BOOT, startOnBoot)
            .putBoolean(EXCLUDE_FROM_RECENTS, excludeFromRecents)
            .commit()) { "后台设置保存失败" }
        return read(context)
    }

    @Synchronized fun beginUserSession(context: Context) {
        prefs(context).edit().putBoolean(USER_STOPPED, false).commit()
    }

    @Synchronized fun stopCurrentSession(context: Context) {
        prefs(context).edit().putBoolean(USER_STOPPED, true).commit()
    }

    @Synchronized fun beginBootSession(context: Context, bootId: Long) {
        prefs(context).edit().putLong(BOOT_ID, bootId).putBoolean(USER_STOPPED, false).commit()
    }

    fun mayRecover(context: Context): Boolean {
        val p = prefs(context)
        return p.getBoolean(KEEP_RUNNING, false) && !p.getBoolean(USER_STOPPED, false)
    }

    fun mayStartOnBoot(context: Context): Boolean =
        prefs(context).getBoolean(START_ON_BOOT, false)
}
