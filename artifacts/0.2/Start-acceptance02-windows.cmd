@echo off
setlocal
if not exist "%TEMP%\lanchat-v4-icons-native-check\lanchat.db" (
  echo Acceptance database missing. Nothing was started.
  pause
  exit /b 1
)
"%~dp0LQ-Chat-0.2-functional-candidate-windows.exe" --db-path "%TEMP%\lanchat-v4-icons-native-check" --port 19877
