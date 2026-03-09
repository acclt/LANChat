package com.lanchat.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
    private var pendingSharedFiles: List<SharedFileInfo>? = null
    private var webView: WebView? = null
    private var shareReceiver: BroadcastReceiver? = null

    data class SharedFileInfo(
        val uri: Uri,
        val fileName: String,
        val fileSize: Long,
        val mimeType: String?
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        
        // 注册广播接收器
        registerShareReceiver()
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
        val jsonArray = JSONArray()
        files.forEach { file ->
            val jsonObj = JSONObject().apply {
                put("uri", file.uri)
                put("fileName", file.fileName)
                put("fileSize", file.fileSize)
                put("mimeType", file.mimeType)
                put("fd", file.fd) // 极为关键：原生层的 fd 直接塞给前端
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
    }
    
    override fun onResume() {
        super.onResume()
        println("[MainActivity] onResume 被调用")
        checkAndPushSharedFiles()
    }
    

    private fun notifyWebView() {
        println("[MainActivity] 准备通知 WebView")
        
        // 使用递归重试机制
        notifyWebViewWithRetry(0)
    }
    
    private fun notifyWebViewWithRetry(attempt: Int) {
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
                        webView?.evaluateJavascript(
                            """
                            (function() {
                                console.log('[MainActivity] 触发 android-share-received 事件');
                                window.dispatchEvent(new CustomEvent('android-share-received'));
                            })();
                            """.trimIndent(),
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
                notifyWebViewWithRetry(attempt + 1)
            }
        }, delayMs)
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
                // 添加读写权限标志
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            
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