@echo off
title Маша - запуск голоса и релея
set ROOT=%~dp0..
cd /d "%ROOT%"

if not exist "%ROOT%\.venv-tts\Scripts\python.exe" (
  echo.
  echo [ОШИБКА] Голос не установлен.
  echo Сначала запусти УСТАНОВИТЬ-ГОЛОС-БЫСТРО.cmd
  echo.
  pause
  exit /b 1
)

echo Открываю два окна:
echo   1^) сервер её голоса  ^(http://127.0.0.1:8788^)
echo   2^) локальный релей    ^(http://127.0.0.1:8787^)
echo.
echo НЕ ЗАКРЫВАЙ эти окна, пока хочешь, чтобы она говорила.
echo.

start "Маша - ГОЛОС" cmd /k ""%ROOT%\.venv-tts\Scripts\python.exe" "%ROOT%\tools\xtts-server.py""
timeout /t 3 >nul

if exist "%USERPROFILE%\masha-key.txt" (
  set /p DEEPSEEK_API_KEY=<"%USERPROFILE%\masha-key.txt"
) else (
  echo Ключ DeepSeek не найден. Переписка идёт через облачный релей,
  echo локальный релей нужен только для её голоса - это нормально.
)
start "Маша - РЕЛЕЙ" cmd /k "set DEEPSEEK_API_KEY=%DEEPSEEK_API_KEY% && python "%ROOT%\worker\local-relay.py""

echo.
echo Готово. Открой приложение и включи озвучку в настройках.
timeout /t 5 >nul