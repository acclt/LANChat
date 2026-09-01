package com.lanchat.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.util.Base64
import android.util.LruCache
import java.io.ByteArrayOutputStream

/** Inline app icons only; no URLs, notification attachments, or native initialization. */
object NotificationAppIcon {
    private const val MAX_BYTES = 8192
    private const val MAX_BASE64 = 10924
    private val cache = LruCache<String, String>(64)

    @Synchronized fun encode(context: Context, pkg: String): String? = runCatching {
        @Suppress("DEPRECATION")
        val updated = context.packageManager.getPackageInfo(pkg, 0).lastUpdateTime
        val key = "$pkg:$updated"
        cache.get(key)?.let { return it }
        val drawable = context.packageManager.getApplicationIcon(pkg)
        for (size in intArrayOf(64, 48, 32)) {
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val bytes = try {
                drawable.setBounds(0, 0, size, size)
                drawable.draw(Canvas(bitmap))
                ByteArrayOutputStream().use { output ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                    output.toByteArray()
                }
            } finally { bitmap.recycle() }
            if (bytes.size <= MAX_BYTES) {
                val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                cache.put(key, encoded)
                return encoded
            }
        }
        null
    }.getOrNull()

    fun decode(encoded: String): Bitmap? = runCatching {
        if (encoded.isEmpty() || encoded.length > MAX_BASE64) return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        if (bytes.size > MAX_BYTES || bytes.size < 33 ||
            !bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth !in 1..96 || bounds.outHeight !in 1..96 || bounds.outMimeType != "image/png") return null
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()
}
