# Windows idle database write optimization

Windows desktop discovery now keeps heartbeat timestamps, online/offline state,
and available memory in RAM. It no longer writes these transient values to SQLite
on every received discovery packet or periodically during idle time.

## Persistence policy

- Only a new peer or a change to its name/address schedules a profile save.
- Changes are coalesced for one second and committed in one transaction. Returning
  to the last committed profile before saving cancels the unnecessary write.
- Existing rows update only `name` and `addr`. New rows use compatibility values
  `last_seen=0`, `is_offline=1`, and `available_memory_mb=0`.
- Historical peers start offline until the current session receives a heartbeat.
  Runtime presence expiration uses a monotonic clock with the existing greater
  than five seconds threshold. Heartbeat frequency and packet format are unchanged.
- Chat messages, file records, delivery status, and settings retain their existing
  persistence paths. The database schema, journal mode, and synchronous settings
  are unchanged.

`PeerPersistence` tracks both the latest desired profile and the last committed
profile. A completed write cannot discard a newer in-memory change, including an
A-to-B-to-A change while B is being committed. Profile writes and user deletion
share one write gate. Windows user deletion removes messages and the user row in
one transaction, invalidating pending profiles only after successful deletion.
Heartbeats received after a completed deletion may rediscover the peer as before.

An idle persistence worker waits for a notification; it does not poll SQLite.
Recoverable write failures retain pending profiles and retry after 5, 15, 30,
then 60 seconds. Duplicate heartbeats cannot bypass this backoff. Diagnostics
remain in memory and are exposed in the Windows background-receive status as
`peer_persistence` (`pending_profiles`, `successful_transactions`, `last_error`).

Normal shutdown rejects further profile observations and attempts a final bounded
flush of pending identity changes only. Each flush is limited to two seconds.
The existing CoreRuntime shutdown deadline remains in force. A failed final save
returns `PEER_PROFILE_SAVE_INCOMPLETE` even when resources have been released.
Forced termination does not guarantee saving newly discovered profile changes;
a subsequent heartbeat can discover them again.

## Platform boundary

The new module is compiled only on Windows and is explicitly enabled by the
Windows desktop entry point. Android, other platforms, and the standalone Web
entry point retain the legacy discovery persistence policy. No Android lifecycle,
permission, notification, protocol, or APK change is required.

## Validation

Tests use temporary SQLite databases, test-only faults/locks, and loopback UDP;
they do not run against a user's chat database.

- 19 regular regression tests passed, including save/delete races, rollback,
  retry backoff, profile reversion during a commit, and CoreRuntime stop results.
- A separate ten-minute test processed 1,501 heartbeat updates in 600.02 seconds.
  The legacy save function produced 1,501 SQLite file change-counter increments.
  The optimized UDP listener produced zero increments and zero successful profile
  write transactions for the same unchanged identity.
- Windows desktop Release build, Android ARM64 library check with default
  features, and the Windows standalone Web binary check passed.

```text
cargo build --manifest-path src-tauri/Cargo.toml --release --bin lanchat --offline
cargo test --manifest-path src-tauri/Cargo.toml --release --lib --no-default-features --features web --offline -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features --features web --offline ten_minute_idle_heartbeat_disk_comparison -- --ignored --nocapture
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android --lib --offline
cargo check --manifest-path src-tauri/Cargo.toml --bin lanchat-web --no-default-features --features web --offline
```

The Android check requires an installed Android Rust target and the existing NDK
compiler tools on the checking process's PATH.

These are controlled database-write measurements, not a whole-system disk or fan
benchmark. WebView caches, discovery reads, messages, files, actual profile
changes, and other applications can still cause disk activity. Real two-device
file transfer, power-loss behavior, and whole-system thermal comparisons were
not exercised by these tests.

For deployment, keep the previous executable and use a consistent SQLite backup.
A shortcut can target the new executable with `--db-path "<existing database directory>"`;
the argument is the directory containing `lanchat.db`, not the database file.
Do not publish a user's database or machine-specific launcher configuration.
