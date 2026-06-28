package com.lanchat.app

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.FileNotFoundException

class FdContentProvider : ContentProvider() {

    companion object {
        @JvmStatic
        external fun nativeGetClonedFd(msgId: Long): Int

        @JvmStatic
        external fun nativeGetFileSize(msgId: Long): Long
    }

    override fun onCreate(): Boolean = true

    /**
     * 第三方 App 读取文件时触发。
     * URI 格式: content://com.lanchat.app.fdprovider/{msg_id}/{file_name}
     */
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val msgIdStr = uri.pathSegments.firstOrNull()
            ?: throw FileNotFoundException("URI path is empty")
        val msgId = msgIdStr.toLongOrNull()
            ?: throw FileNotFoundException("Invalid msgId: $msgIdStr")

        println("[FdContentProvider] openFile: msgId=$msgId")

        val fd = nativeGetClonedFd(msgId)
        if (fd < 0) {
            println("[FdContentProvider] FD not found for msgId=$msgId")
            throw FileNotFoundException("File expired or app was restarted")
        }

        println("[FdContentProvider] adoptFd: fd=$fd for msgId=$msgId")
        return ParcelFileDescriptor.adoptFd(fd)
    }

    /**
     * 其他 App（包括 LANChat 自己）查询文件元数据时触发。
     * 从 Rust FD 缓存获取真实文件名和大小。
     */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor? {
        val msgIdStr = uri.pathSegments.firstOrNull() ?: return null
        val msgId = msgIdStr.toLongOrNull() ?: return null
        val fileName = uri.lastPathSegment ?: "shared_file"

        val fileSize = nativeGetFileSize(msgId)
        if (fileSize < 0) return null // 缓存已失效

        val proj = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(proj)
        val row = cursor.newRow()

        for (col in proj) {
            when (col) {
                OpenableColumns.DISPLAY_NAME -> row.add(fileName)
                OpenableColumns.SIZE -> row.add(fileSize)
                else -> row.add(null)
            }
        }
        return cursor
    }

    override fun getType(uri: Uri): String? {
        val fileName = uri.lastPathSegment ?: return "*/*"
        val ext = fileName.substringAfterLast('.', "")
        if (ext.isEmpty()) return "*/*"
        return MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(ext.lowercase()) ?: "*/*"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
