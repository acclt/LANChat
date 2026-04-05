.PHONY: all deb rpm apk windows-desktop web web-windows clean help

all: deb rpm apk windows-desktop web web-windows

# 桌面端 Linux
deb:
	cargo tauri build --bundles deb

rpm:
	cargo tauri build --bundles rpm

# 安卓 APK
apk:
	cargo tauri android build --target aarch64
	./sign-apk.sh

# Windows 桌面端（需要 cargo-xwin）
windows-desktop:
	cd src-tauri && cargo xwin build --release --bin lanchat --target x86_64-pc-windows-msvc

# Web 端 Linux
web:
	cd src-tauri && cargo build --release --bin lanchat-web --features web --no-default-features

# Web 端 Windows
web-windows:
	cd src-tauri && cargo build --no-default-features --features web --release --target x86_64-pc-windows-gnu

help:
	@echo "可用目标:"
	@echo "  deb             - 构建 Linux .deb 包"
	@echo "  rpm             - 构建 Linux .rpm 包"
	@echo "  apk             - 构建并签名 Android APK"
	@echo "  windows-desktop - 构建 Windows 桌面端 (需要 cargo-xwin)"
	@echo "  web             - 构建 Web 端 (Linux)"
	@echo "  web-windows     - 构建 Web 端 (Windows)"
