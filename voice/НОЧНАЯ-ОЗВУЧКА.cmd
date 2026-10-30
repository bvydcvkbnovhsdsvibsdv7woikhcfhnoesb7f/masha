@echo off
title Маша - ночная озвучка фраз (не закрывай окно!)
set ROOT=%~dp0..
cd /d "%ROOT%"
set VPY=%ROOT%\.venv-tts\Scripts\python.exe
set LOG=%ROOT%\voice\night-log.txt

echo ============================================================
echo   НОЧНАЯ ОЗВУЧКА ФРАЗ ЕЁ ГОЛОСОМ
echo.
echo   Скрипт озвучивает её самые частые фразы и сохраняет их.
echo   Готовые фразы пропускаются, можно прерывать и запускать снова.
echo.
echo   ВАЖНО: окно не закрывай, ноутбук не выключай,
echo   крышку оставь ОТКРЫТОЙ.
echo.
echo   В конце скрипт сам выложит голос на сайт,
echo   чтобы утром он работал на телефоне.
echo ============================================================
echo.

echo === старт %DATE% %TIME% === > "%LOG%"

:loop
echo.
echo --- запускаю озвучку (до 1200 фраз, продолжит с места остановки) ---
echo --- порция, %DATE% %TIME% --- >> "%LOG%"
"%VPY%" "%ROOT%\tools\pregenerate-voice.py" 1200 0 >> "%LOG%" 2>&1
if errorlevel 3 goto lowmem
for /f %%c in ('dir /b "%ROOT%\voice\cache\*.wav" 2^>nul ^| find /c /v ""') do set CNT=%%c
echo.
echo Озвучено фраз: %CNT% из 1200
echo озвучено: %CNT% >> "%LOG%"
if %CNT% LSS 1200 goto loop

echo.
echo Все 1200 фраз готовы. Публикую на сайт...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\publish-voice-cache.ps1" >> "%LOG%" 2>&1
echo.
echo ГОТОВО. Её голос выложен для телефона.
pause
exit /b 0

:lowmem
echo.
echo Мало памяти - останавливаюсь. Закрой программы и запусти снова.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\publish-voice-cache.ps1" >> "%LOG%" 2>&1
pause
exit /b 1