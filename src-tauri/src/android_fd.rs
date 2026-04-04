// android_fd.rs - Android 文件描述符处理
#[cfg(target_os = "android")]
use std::os::unix::io::{FromRawFd, RawFd};

#[cfg(target_os = "android")]
pub struct AndroidFile {
    file: std::fs::File,
}

#[cfg(target_os = "android")]
impl AndroidFile {
    /// 从文件描述符创建 File 对象
    pub fn from_fd(fd: RawFd) -> Result<Self, String> {
        if fd < 0 {
            return Err("无效的文件描述符".to_string());
        }

        println!("[AndroidFD] 从 FD 创建文件对象: fd={}", fd);

        // SAFETY: 我们假设 FD 是有效的，由 Android ContentResolver 提供
        let file = unsafe { std::fs::File::from_raw_fd(fd) };

        Ok(AndroidFile { file })
    }

    /// 获取内部的 File 对象
    pub fn into_file(self) -> std::fs::File {
        self.file
    }
    
    /// 从 content:// URI 获取文件描述符
    /// 这需要通过 JNI 调用 Android 的 ContentResolver
    pub fn from_content_uri(uri: &str) -> Result<Self, String> {
        println!("[AndroidFD] 尝试从 content URI 获取 FD: {}", uri);
        
        // 使用 ndk-context 获取 Android 上下文
        use jni::objects::{JObject, JValue};
        use jni::JavaVM;
        
        // 获取 JNI 环境
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("无法获取 JavaVM: {}", e))?;
        
        let mut env = vm.attach_current_thread()
            .map_err(|e| format!("无法附加到当前线程: {}", e))?;
        
        // 获取 Context 对象
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        
        // 调用 ContentResolver
        let content_resolver = env.call_method(
            context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[]
        ).map_err(|e| format!("无法获取 ContentResolver: {}", e))?
        .l().map_err(|e| format!("无法转换为对象: {}", e))?;
        
        // 创建 URI 对象
        let uri_string = env.new_string(uri)
            .map_err(|e| format!("无法创建 URI 字符串: {}", e))?;
        
        let uri_obj = env.call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&JObject::from(uri_string))]
        ).map_err(|e| format!("无法解析 URI: {}", e))?
        .l().map_err(|e| format!("无法转换为对象: {}", e))?;
        
        // 打开文件描述符
        let mode_string = env.new_string("r")
            .map_err(|e| format!("无法创建模式字符串: {}", e))?;
        
        let pfd_result = env.call_method(
            content_resolver,
            "openFileDescriptor",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
            &[
                JValue::Object(&uri_obj),
                JValue::Object(&JObject::from(mode_string))
            ]
        );

        // 捕获 Java 异常（SecurityException / FileNotFoundException）
        // 必须先清除 JVM 异常状态，否则后续任何 JNI 调用都会崩溃
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe(); // 打印到 logcat 方便调试
            let _ = env.exception_clear();
            return Err(format!("content URI 权限已过期或文件不存在: {}", uri));
        }

        let pfd = pfd_result
            .map_err(|e| format!("无法打开文件描述符: {}", e))?
            .l().map_err(|e| format!("无法转换为对象: {}", e))?;

        if pfd.is_null() {
            return Err(format!("openFileDescriptor 返回 null: {}", uri));
        }
        
        // 获取文件描述符
        let fd = env.call_method(
            pfd,
            "detachFd",
            "()I",
            &[]
        ).map_err(|e| format!("无法分离文件描述符: {}", e))?
        .i().map_err(|e| format!("无法转换为整数: {}", e))?;
        
        println!("[AndroidFD] 成功获取文件描述符: fd={}", fd);
        
        Self::from_fd(fd)
    }

    /// 通过 ContentResolver 查询 content URI 的真实文件名和大小
    /// 对应 Android 的 OpenableColumns.DISPLAY_NAME / SIZE
    pub fn query_content_uri_info(uri: &str) -> Result<(String, u64), String> {
        println!("[AndroidFD] 查询 content URI 文件信息: {}", uri);

        use jni::objects::{JObject, JValue};
        use jni::JavaVM;

        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("无法获取 JavaVM: {}", e))?;

        let mut env = vm.attach_current_thread()
            .map_err(|e| format!("无法附加到当前线程: {}", e))?;

        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        // 获取 ContentResolver
        let content_resolver = env.call_method(
            &context,
            "getContentResolver",
            "()Landroid/content/ContentResolver;",
            &[],
        ).map_err(|e| format!("无法获取 ContentResolver: {}", e))?
        .l().map_err(|e| format!("转换失败: {}", e))?;

        // 解析 URI
        let uri_jstring = env.new_string(uri)
            .map_err(|e| format!("创建字符串失败: {}", e))?;
        let uri_obj = env.call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&JObject::from(uri_jstring))],
        ).map_err(|e| format!("解析 URI 失败: {}", e))?
        .l().map_err(|e| format!("转换失败: {}", e))?;

        // 调用 contentResolver.query(uri, null, null, null, null)
        let cursor = env.call_method(
            &content_resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                JValue::Object(&uri_obj),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
            ],
        ).map_err(|e| format!("query 失败: {}", e))?
        .l().map_err(|e| format!("转换失败: {}", e))?;

        if cursor.is_null() {
            return Err("ContentResolver.query 返回 null".to_string());
        }

        // moveToFirst()
        let has_row = env.call_method(&cursor, "moveToFirst", "()Z", &[])
            .map_err(|e| format!("moveToFirst 失败: {}", e))?
            .z().map_err(|e| format!("转换失败: {}", e))?;

        if !has_row {
            let _ = env.call_method(&cursor, "close", "()V", &[]);
            return Err("Cursor 为空，无法获取文件信息".to_string());
        }

        // 获取 DISPLAY_NAME 列索引
        let display_name_col = {
            let col_name = env.new_string("_display_name")
                .map_err(|e| format!("创建字符串失败: {}", e))?;
            env.call_method(
                &cursor,
                "getColumnIndex",
                "(Ljava/lang/String;)I",
                &[JValue::Object(&JObject::from(col_name))],
            ).map_err(|e| format!("getColumnIndex 失败: {}", e))?
            .i().map_err(|e| format!("转换失败: {}", e))?
        };

        // 获取 SIZE 列索引
        let size_col = {
            let col_name = env.new_string("_size")
                .map_err(|e| format!("创建字符串失败: {}", e))?;
            env.call_method(
                &cursor,
                "getColumnIndex",
                "(Ljava/lang/String;)I",
                &[JValue::Object(&JObject::from(col_name))],
            ).map_err(|e| format!("getColumnIndex 失败: {}", e))?
            .i().map_err(|e| format!("转换失败: {}", e))?
        };

        // 读取文件名
        let file_name = if display_name_col >= 0 {
            let name_obj = env.call_method(
                &cursor,
                "getString",
                "(I)Ljava/lang/String;",
                &[JValue::Int(display_name_col)],
            ).map_err(|e| format!("getString 失败: {}", e))?
            .l().map_err(|e| format!("转换失败: {}", e))?;

            if name_obj.is_null() {
                String::new()
            } else {
                let jstr = unsafe { jni::objects::JString::from_raw(name_obj.into_raw()) };
                env.get_string(&jstr)
                    .map(|s| s.into())
                    .unwrap_or_default()
            }
        } else {
            String::new()
        };

        // 读取文件大小
        let file_size = if size_col >= 0 {
            env.call_method(
                &cursor,
                "getLong",
                "(I)J",
                &[JValue::Int(size_col)],
            ).map_err(|e| format!("getLong 失败: {}", e))?
            .j().map_err(|e| format!("转换失败: {}", e))
            .unwrap_or(0) as u64
        } else {
            0u64
        };

        let _ = env.call_method(&cursor, "close", "()V", &[]);

        println!("[AndroidFD] 查询结果: 文件名={}, 大小={}", file_name, file_size);
        Ok((file_name, file_size))
    }
}

#[cfg(not(target_os = "android"))]
pub struct AndroidFile;

#[cfg(not(target_os = "android"))]
impl AndroidFile {
    pub fn from_fd(_fd: i32) -> Result<Self, String> {
        Err("此功能仅在 Android 上可用".to_string())
    }

    pub fn into_file(self) -> std::fs::File {
        panic!("此功能仅在 Android 上可用")
    }
    
    pub fn from_content_uri(_uri: &str) -> Result<Self, String> {
        Err("此功能仅在 Android 上可用".to_string())
    }
}
