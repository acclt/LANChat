package com.lanchat.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Base64
import android.util.Size
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream

// 通知 Intent 的 Key 常量（来自 tauri-plugin-notification）
private const val NOTIFICATION_INTENT_KEY = "NotificationId"
private const val NOTIFICATION_OBJ_INTENT_KEY = "LocalNotficationObject"
private const val ACTION_INTENT_KEY = "NotificationUserAction"

class MainActivity : TauriActivity() {
    // ─── JNI：Rust 侧的回调 ───
    private external fun nativeOnSafFileSelected(uri: String, name: String, size: Long)
    private external fun nativeSetUiVisibility(visible: Boolean)

    private var pendingSharedFiles: List<SharedFileInfo>? = null
    private var webView: WebView? = null
    private var shareReceiver: BroadcastReceiver? = null
    private var lastNotificationFromId: String? = null

    // ─── SAF 文件选择器（持久化权限） ───
    private val safPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            handleSafSelectedFile(uri)
        }
    }

    private val safMultiPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris: List<Uri> ->
        val result = JSONArray()
        uris.forEach { uri ->
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
                // 部分文档提供方不支持持久化；Rust 发送端会复制到持久队列作为兜底。
            }
            result.put(queryAttachment(uri))
        }
        dispatchJsonEvent("android-files-selected", result)
    }

    private val downloadDirectoryPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: Uri? ->
        if (uri != null) {
            try {
                val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                contentResolver.takePersistableUriPermission(uri, takeFlags)
                val treeName = runCatching {
                    DocumentsContract.getTreeDocumentId(uri)
                        .substringAfter(':')
                        .ifBlank { "已选择的文件夹" }
                }.getOrDefault("已选择的文件夹")
                dispatchObjectEvent("android-download-directory-selected", JSONObject().apply {
                    put("uri", uri.toString())
                    put("label", treeName)
                })
            } catch (error: Exception) {
                dispatchObjectEvent("android-download-directory-error", JSONObject().apply {
                    put("message", error.message ?: "无法取得文件夹写入权限")
                })
            }
        }
    }

    private val mediaPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions.values.any { it }) queryAndDispatchImages()
        else dispatchJsonEvent("android-media-images", JSONArray())
    }

    data class SharedFileInfo(
        val uri: Uri,
        val fileName: String,
        val fileSize: Long,
        val mimeType: String?
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        AndroidDownloadStore.initialize(applicationContext)

        // 开启 WebView 调试（方便 adb logcat 看到 JS console 输出）
        android.webkit.WebView.setWebContentsDebuggingEnabled(true)
        
        // 注册广播接收器
        registerShareReceiver()
        
        // 检测冷启动是否来自通知点击
        checkNotificationLaunch(intent)
    }

    override fun onStart() {
        super.onStart()
        nativeSetUiVisibility(true)
        // nativeSetUiVisibility 成功返回，证明本进程的 Rust 库已由可见 Activity 加载。
        // 只有这里签发的单次令牌可以激活 Service；Service-only 重建没有这个资格。
        LanChatForegroundService.startVisibleUserSession(this)
    }

    override fun onStop() {
        nativeSetUiVisibility(false)
        super.onStop()
    }

    @Keep
    fun retryBackgroundService() {
        LanChatForegroundService.retryVisibleUserSession(this)
    }

    @Keep
    fun stopBackgroundReceiveAndExit() {
        LanChatForegroundService.stopVisibleUserSession(this)
        finishAndRemoveTask()
    }

    @Keep
    fun getBatteryOptimizationState(): String {
        val manager = getSystemService(PowerManager::class.java)
        return if (manager.isIgnoringBatteryOptimizations(packageName)) "unrestricted" else "optimized"
    }

    @Keep
    fun openBatteryOptimizationSettings() {
        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    @Keep
    fun getNotificationPermissionState(): String {
        return if (Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) "granted" else "denied"
    }

    /**
     * 供 Rust JNI 调用：打开 SAF 文件选择器
     */
    fun launchSafFilePicker() {
        runOnUiThread {
            safPickerLauncher.launch(arrayOf("*/*"))
        }
    }

    @Keep
    fun launchSafMultiFilePicker() {
        runOnUiThread { safMultiPickerLauncher.launch(arrayOf("*/*")) }
    }

    @Keep
    fun launchDownloadDirectoryPicker() {
        runOnUiThread { downloadDirectoryPickerLauncher.launch(null) }
    }

    @Keep
    fun loadMediaImages() {
        runOnUiThread {
            val permission = if (Build.VERSION.SDK_INT >= 33) android.Manifest.permission.READ_MEDIA_IMAGES
                else android.Manifest.permission.READ_EXTERNAL_STORAGE
            if (checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                queryAndDispatchImages()
            } else {
                mediaPermissionLauncher.launch(arrayOf(permission))
            }
        }
    }

    @Keep
    fun loadInstalledApps() {
        Thread {
            val result = JSONArray()
            try {
                packageManager.getInstalledApplications(android.content.pm.PackageManager.GET_META_DATA)
                    .asSequence()
                    .filter { info ->
                        info.packageName != packageName &&
                            (info.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) == 0 &&
                            !info.sourceDir.isNullOrBlank() && File(info.sourceDir).canRead()
                    }
                    .sortedBy { packageManager.getApplicationLabel(it).toString().lowercase() }
                    .forEach { info ->
                        val source = File(info.sourceDir)
                        result.put(JSONObject().apply {
                            put("name", "${packageManager.getApplicationLabel(info)}.apk")
                            put("label", packageManager.getApplicationLabel(info).toString())
                            put("packageName", info.packageName)
                            put("path", info.sourceDir)
                            put("size", source.length())
                            put("icon", drawableToDataUrl(packageManager.getApplicationIcon(info)))
                        })
                    }
            } catch (e: Exception) {
                println("[MainActivity] 读取 App 列表失败: ${e.message}")
            }
            dispatchJsonEvent("android-apps-loaded", result)
        }.start()
    }

    private fun queryAttachment(uri: Uri): JSONObject {
        var fileName = "unknown_file"
        var fileSize = 0L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) fileName = cursor.getString(nameIndex) ?: fileName
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) fileSize = cursor.getLong(sizeIndex)
            }
        }
        return JSONObject().apply {
            put("uri", uri.toString())
            put("name", fileName)
            put("size", fileSize)
        }
    }

    private fun queryAndDispatchImages() {
        Thread {
            val result = JSONArray()
            val projection = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME
            )
            try {
                contentResolver.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    projection,
                    null,
                    null,
                    "${MediaStore.Images.Media.DATE_MODIFIED} DESC"
                )?.use { cursor ->
                    val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                    val nameIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
                    val bucketIndex = cursor.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
                    var count = 0
                    while (cursor.moveToNext() && count < 120) {
                        val uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(idIndex).toString())
                        val thumbnail = try {
                            if (Build.VERSION.SDK_INT >= 29) bitmapToDataUrl(contentResolver.loadThumbnail(uri, Size(240, 240), null)) else ""
                        } catch (_: Exception) { "" }
                        result.put(JSONObject().apply {
                            put("uri", uri.toString())
                            put("name", cursor.getString(nameIndex) ?: "image_$count.jpg")
                            put("size", cursor.getLong(sizeIndex))
                            put("album", if (bucketIndex >= 0) cursor.getString(bucketIndex) ?: "其他" else "其他")
                            put("thumbnail", thumbnail)
                        })
                        count++
                    }
                }
            } catch (e: Exception) {
                println("[MainActivity] 读取相册失败: ${e.message}")
            }
            dispatchJsonEvent("android-media-images", result)
        }.start()
    }

    private fun bitmapToDataUrl(bitmap: Bitmap): String {
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 72, output)
        return "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }

    private fun drawableToDataUrl(drawable: android.graphics.drawable.Drawable): String {
        val bitmap = if (drawable is BitmapDrawable) drawable.bitmap else {
            val width = drawable.intrinsicWidth.coerceAtLeast(1).coerceAtMost(128)
            val height = drawable.intrinsicHeight.coerceAtLeast(1).coerceAtMost(128)
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
                val canvas = Canvas(it)
                drawable.setBounds(0, 0, canvas.width, canvas.height)
                drawable.draw(canvas)
            }
        }
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 90, output)
        return "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }

    private fun dispatchJsonEvent(name: String, payload: JSONArray) {
        if (webView == null) webView = findWebView(window.decorView)
        runOnUiThread {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)}, {detail: $payload}));",
                null
            )
        }
    }

    private fun handleSafSelectedFile(uri: Uri) {
        try {
            // 持久化读取权限
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, takeFlags)

            // 提取文件名和大小
            var fileName = "unknown_file"
            var fileSize: Long = 0
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    if (nameIndex >= 0) fileName = cursor.getString(nameIndex)
                    if (sizeIndex >= 0) fileSize = cursor.getLong(sizeIndex)
                }
            }

            // 回调 Rust 侧，走 Tauri 事件总线广播给前端
            nativeOnSafFileSelected(uri.toString(), fileName, fileSize)

        } catch (e: Exception) {
            println("[MainActivity] SAF 文件选择持久化失败: ${e.message}")
            e.printStackTrace()
        }
    }

    private fun checkNotificationLaunch(intent: Intent?) {
        if (intent == null) return
        intent.getStringExtra(LanChatForegroundService.EXTRA_PEER_ID)?.let { peerId ->
            window.decorView.postDelayed({ notifyPeerOpened(peerId) }, 1000)
            return
        }
        val action = intent.getStringExtra(ACTION_INTENT_KEY)
        if (action == "tap") {
            println("[MainActivity] 冷启动来自通知点击")
            // 延迟等 WebView 就绪后再通知 JS
            window.decorView.postDelayed({
                notifyNotificationClicked()
            }, 1000)
        }
    }

    private fun registerShareReceiver() {
        shareReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                println("[MainActivity] 收到分享广播")
                checkAndPushSharedFiles()
            }
        }
        val filter = IntentFilter("com.lanchat.app.SHARE_RECEIVED")
        registerReceiver(shareReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    }

    // 核心推送函数
    private fun checkAndPushSharedFiles() {
        val files = ShareDataHolder.sharedFiles
        if (files == null || files.isEmpty()) return

        println("[MainActivity] 准备推送 ${files.size} 个文件到前端")
        
        // 一旦取出数据，立刻清空保险箱！
        // 这样哪怕 onResume 和 广播 同时触发，第二个进来的也只能拿到 null，彻底杜绝双重注入！
        ShareDataHolder.sharedFiles = null

        val jsonArray = JSONArray()
        files.forEach { file ->
            val jsonObj = JSONObject().apply {
                put("uri", file.uri)
                put("fileName", file.fileName)
                put("fileSize", file.fileSize)
                put("mimeType", file.mimeType)
                put("fd", file.fd)
            }
            jsonArray.put(jsonObj)
        }
        val jsonString = jsonArray.toString()
        
        injectDataIntoWebView(jsonString, 0)
    }

    // 智能重试空投机制
    private fun injectDataIntoWebView(jsonString: String, attempt: Int) {
        val maxAttempts = 20 // 允许重试20次（10秒），彻底防住冷启动慢的问题
        if (attempt >= maxAttempts) {
            println("[MainActivity] 放弃注入分享数据，重试次数过多")
            return
        }

        if (webView == null) {
            webView = findWebView(window.decorView)
        }

        if (webView != null) {
            runOnUiThread {
                webView?.evaluateJavascript(
                    """
                    (function() {
                        // 确保 JS 运行环境已存在
                        if (typeof window !== 'undefined') {
                            // 直接把数据空投进 window 全局变量
                            window.__ANDROID_SHARED_FILES__ = $jsonString;
                            console.log('[MainActivity->JS] 数据已成功空投到 window.__ANDROID_SHARED_FILES__');
                            // 触发事件通知前端
                            if (window.dispatchEvent) {
                                window.dispatchEvent(new CustomEvent('android-share-received'));
                            }
                            return "success";
                        }
                        return "not_ready";
                    })();
                    """.trimIndent()
                ) { result ->
                    if (result == "\"success\"") {
                        println("[MainActivity] 数据成功推送到前端 (尝试 ${attempt + 1})")
                        // 确保只推送一次，推送成功后立刻清空原生层保险箱
                        ShareDataHolder.sharedFiles = null 
                    } else {
                        println("[MainActivity] 前端 window 未就绪，500ms 后重试...")
                        window.decorView.postDelayed({ injectDataIntoWebView(jsonString, attempt + 1) }, 500)
                    }
                }
            }
        } else {
            println("[MainActivity] 找不到 WebView，500ms 后重试...")
            window.decorView.postDelayed({ injectDataIntoWebView(jsonString, attempt + 1) }, 500)
        }
    }

    override fun onDestroy() {
        nativeSetUiVisibility(false)
        super.onDestroy()
        // 注销广播接收器
        shareReceiver?.let {
            unregisterReceiver(it)
            println("[MainActivity] 广播接收器已注销")
        }
    }

    private fun findWebView(view: android.view.View): WebView? {
        println("[MainActivity] 检查 View: ${view.javaClass.name}")
        
        if (view is WebView) {
            println("[MainActivity] 找到 WebView: ${view.javaClass.name}")
            return view
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                val child = view.getChildAt(i)
                val result = findWebView(child)
                if (result != null) {
                    return result
                }
            }
        }
        return null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        
        intent.getStringExtra(LanChatForegroundService.EXTRA_PEER_ID)?.let { peerId ->
            notifyPeerOpened(peerId)
            return
        }

        // 检测通知点击：NotificationUserAction == "tap" 表示通知被点击
        val action = intent.getStringExtra(ACTION_INTENT_KEY)
        if (action == "tap") {
            println("[MainActivity] 通知被点击")
            // 通知 JS 从 localStorage 读取 from_id 并导航
            notifyNotificationClicked()
        }
    }
    
    override fun onResume() {
        super.onResume()
        println("[MainActivity] onResume 被调用")
        checkAndPushSharedFiles()
    }
    

    private fun notifyNotificationClicked() {
        // 通知前端从 localStorage 读取 pendingFromId 并导航
        notifyWebViewWithRetry(0, """
            (function() {
                console.log('[MainActivity] 通知被点击，尝试导航');
                var fromId = localStorage.getItem('pendingNotificationFromId');
                if (fromId) {
                    localStorage.removeItem('pendingNotificationFromId');
                    window.dispatchEvent(new CustomEvent('notification-tapped', {detail: {fromId: fromId}}));
                }
            })();
        """.trimIndent())
    }

    private fun dispatchObjectEvent(name: String, payload: JSONObject) {
        if (webView == null) webView = findWebView(window.decorView)
        runOnUiThread {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)}, {detail: $payload}));",
                null
            )
        }
    }

    private fun notifyPeerOpened(peerId: String) {
        notifyWebViewWithRetry(0, """
            window.dispatchEvent(new CustomEvent('notification-tapped', {
                detail: {fromId: ${JSONObject.quote(peerId)}}
            }));
        """.trimIndent())
    }
    
    private fun notifyWebView() {
        println("[MainActivity] 准备通知 WebView")
        
        // 使用递归重试机制
        notifyWebViewWithRetry(0)
    }
    
    private fun notifyWebViewWithRetry(attempt: Int, jsCode: String = """
        (function() {
            console.log('[MainActivity] 触发 android-share-received 事件');
            window.dispatchEvent(new CustomEvent('android-share-received'));
        })();
    """.trimIndent()) {
        val maxAttempts = 10
        val delayMs = 500L
        
        if (attempt >= maxAttempts) {
            println("[MainActivity] 达到最大重试次数，放弃通知")
            return
        }
        
        window.decorView.postDelayed({
            // 尝试重新查找 WebView
            if (webView == null) {
                webView = findWebView(window.decorView)
            }
            
            if (webView != null) {
                println("[MainActivity] WebView 已就绪（尝试 ${attempt + 1}），发送事件")
                runOnUiThread {
                    try {
                        webView?.evaluateJavascript(jsCode,
                            { result ->
                                println("[MainActivity] JavaScript 执行结果: $result")
                            }
                        )
                        println("[MainActivity] 已触发 android-share-received 事件")
                    } catch (e: Exception) {
                        println("[MainActivity] 执行 JavaScript 失败: ${e.message}")
                    }
                }
            } else {
                println("[MainActivity] WebView 未就绪（尝试 ${attempt + 1}），继续重试...")
                notifyWebViewWithRetry(attempt + 1, jsCode)
            }
        }, delayMs)
    }

    // 打开文件（用对应的应用打开）
    @Keep
    fun openFile(filePath: String) {
        try {
            println("[MainActivity] 准备打开文件: $filePath")

            val uri: Uri
            val mimeType: String

            if (filePath.startsWith("content://")) {
                uri = Uri.parse(filePath)
                mimeType = contentResolver.getType(uri) ?: "*/*"
                println("[MainActivity] 使用 content URI: $uri")
            } else {
                val file = File(filePath)
                if (!file.exists()) {
                    println("[MainActivity] 文件不存在: $filePath")
                    return
                }
                uri = FileProvider.getUriForFile(
                    this,
                    "${applicationContext.packageName}.fileprovider",
                    file
                )
                mimeType = contentResolver.getType(uri) ?: "*/*"
                println("[MainActivity] FileProvider URI: $uri")
            }

            println("[MainActivity] MIME 类型: $mimeType")

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            try {
                startActivity(intent)
                println("[MainActivity] 打开文件 Intent 已启动")
            } catch (e: SecurityException) {
                // content URI 权限过期，降级为 */* 再试一次
                println("[MainActivity] 权限异常，降级为 */* 重试: ${e.message}")
                val fallbackIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "*/*")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(fallbackIntent)
                println("[MainActivity] 降级打开文件 Intent 已启动")
            }
        } catch (e: Exception) {
            println("[MainActivity] 打开文件失败: ${e.message}")
            e.printStackTrace()
        }
    }

    // 分享文件到其他应用
    @Keep   // <--- 就是这块免死金牌！告诉混淆器绝对不要动这个函数
    fun shareFile(filePath: String) {
        try {
            println("[MainActivity] 准备分享文件: $filePath")
            
            val uri: Uri
            val mimeType: String
            
            if (filePath.startsWith("content://")) {
                // 已经是 content URI，直接使用
                uri = Uri.parse(filePath)
                mimeType = contentResolver.getType(uri) ?: "*/*"
                println("[MainActivity] 使用 content URI: $uri")
            } else {
                // 普通文件路径，使用 FileProvider
                val file = File(filePath)
                if (!file.exists()) {
                    println("[MainActivity] 文件不存在: $filePath")
                    return
                }
                
                uri = FileProvider.getUriForFile(
                    this,
                    "${applicationContext.packageName}.fileprovider",
                    file
                )
                mimeType = contentResolver.getType(uri) ?: "*/*"
                println("[MainActivity] FileProvider URI: $uri")
            }
            
            println("[MainActivity] MIME 类型: $mimeType")
            
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }

            // 附加 ClipData，让系统 UI（分享面板缩略图）也能合法访问 URI，消除 SecurityException 日志
            val clipData = android.content.ClipData.newUri(contentResolver, "share_file", uri)
            intent.clipData = clipData
            
            // 创建分享选择器并授予权限
            val chooser = Intent.createChooser(intent, "分享文件").apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            
            // 显示分享选择器
            startActivity(chooser)
            println("[MainActivity] 分享选择器已启动")
        } catch (e: Exception) {
            println("[MainActivity] 分享文件失败: ${e.message}")
            e.printStackTrace()
        }
    }
}
