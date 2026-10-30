@echo off
title Разрешить телефону доступ к голосу Маши
echo Запрашиваю права администратора (появится окно UAC - нажми "Да")...
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath 'netsh' -ArgumentList 'advfirewall firewall add rule name=\"Masha XTTS 8788\" dir=in action=allow protocol=TCP localport=8788' -Wait"
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath 'netsh' -ArgumentList 'advfirewall firewall add rule name=\"Masha App 8080\" dir=in action=allow protocol=TCP localport=8080' -Wait"
echo.
echo Готово: порты 8788 и 8080 открыты для телефона.
echo Если UAC отменил - доступ к телефону не будет работать.
echo.
pause