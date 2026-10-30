@echo off
title Проверка голоса Маши
set ROOT=%~dp0..
cd /d "%ROOT%"
echo Отправляю тестовую фразу на сервер голоса...
curl.exe -s -X POST http://127.0.0.1:8788/tts -H "Content-Type: application/json" -d "{\"text\":\"привет, это мой голос\"}" --output "%TEMP%\test-golos.wav"
if exist "%TEMP%\test-golos.wav" (
  for %%A in ("%TEMP%\test-golos.wav") do echo Файл создан: %%~zA байт
  echo Открываю...
  start "" "%TEMP%\test-golos.wav"
) else (
  echo [ОШИБКА] Сервер голоса не ответил. Запущен ли СТАРТ-ВСЁ.cmd?
)
echo.
pause