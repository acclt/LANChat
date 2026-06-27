# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ── LANChat JNI & SAF Custom Picker ProGuard Rules ──

# 保留 MainActivity 完整类结构（含 external fun 和 JNI 反射调用的方法）
-keep class com.lanchat.app.MainActivity { *; }

# 保留所有 native 方法声明（防止 JNI 外部函数被 R8 裁剪）
-keepclasseswithmembernames class * { native <methods>; }

# 保留 ndk-context 引导类（Tauri JNI 初始化需要）
-keep class ndk_context.** { *; }

# ── Tauri Plugins Protection（防止通知、对话框等插件在 Release 下失效）──

# 保留 Tauri 核心包名下的所有类（Rust 侧通过反射调用）
-keep class app.tauri.** { *; }

# 保留所有继承自 Tauri 插件基类的子类（极其重要！）
-keep class * extends app.tauri.plugin.Plugin { *; }

# 额外确保通知插件本身不被混淆
-keep class app.tauri.plugin.notification.** { *; }