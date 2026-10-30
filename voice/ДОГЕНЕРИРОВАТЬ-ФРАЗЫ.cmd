@echo off
title Маша - догенерировать её фразы в кэш
set ROOT=%~dp0..
cd /d "%ROOT%"

echo ============================================================
echo   ОЗВУЧКА ЕЁ ФРАЗ В КЭШ
echo   Каждая фраза ~30-120 секунд. Можно прерывать и запускать снова -
echo   готовые фразы пропускаются.
echo   НЕ ОТКРЫВАЙ браузер и тяжёлые программы, пока идёт озвучка!
echo ============================================================
echo.

if not exist "%ROOT%\.venv-tts\Scripts\python.exe" (
  echo [ОШИБКА] Сначала установи голос: УСТАНОВИТЬ-ГОЛОС-БЫСТРО.cmd
  pause
  exit /b 1
)

"%ROOT%\.venv-tts\Scripts\python.exe" "%ROOT%\tools\pregenerate-voice.py" 600 0
echo.
echo Готово. Фраз в кэше:
dir /b "%ROOT%\voice\cache\*.wav" 2>nul | find /c /v ""
echo.
pause