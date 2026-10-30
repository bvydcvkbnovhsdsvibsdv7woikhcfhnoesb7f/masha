@echo off
title Маша - режим для телефона (не закрывай!)
set ROOT=%~dp0..
cd /d "%ROOT%"

echo ============================================================
echo   МАША ДЛЯ ТЕЛЕФОНА
echo.
echo   Открываю:
echo     1^) сервер её голоса на этом компьютере (порт 8788)
echo     2^) само приложение для телефона       (порт 8080)
echo.
echo   Телефон должен быть в ТОЙ ЖЕ Wi-Fi сети, что и ноутбук.
echo   Адрес для телефона будет показан ниже и в окне приложения.
echo.
echo   ПЕРВЫЙ РАЗ: запусти РАЗРЕШИТЬ-ТЕЛЕФОН.cmd (один раз, от админа).
echo ============================================================
echo.

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do set LAN=%%b
)
if "%LAN%"=="" set LAN=192.168.1.107
echo Адрес для телефона:  http://%LAN%:8080/
echo Адрес её голоса:      http://%LAN%:8788
echo.

start "Маша - ГОЛОС (телефон)" cmd /k ""%ROOT%\.venv-tts\Scripts\python.exe" "%ROOT%\tools\xtts-server.py""
timeout /t 2 >nul
start "Маша - ПРИЛОЖЕНИЕ (телефон)" cmd /k "cd /d "%ROOT%" && python -m http.server 8080 --bind 0.0.0.0"

echo.
echo Открой на телефоне:  http://%LAN%:8080/
echo В настройках приложения включи "Озвучивать её голосом".
echo.
echo НЕ ЗАКРЫВАЙ окна, пока пользуешься телефоном.
pause