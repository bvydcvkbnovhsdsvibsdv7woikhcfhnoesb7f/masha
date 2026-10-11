Сюда можно положить JSON-файлы переписки (например, твои два файла).

Тогда при сборке APK (GitHub Actions) архив соберётся автоматически:
шаг «Build memory archive from source/*.json» создаст
archive/masha-archive.json.gz и archive/masha-index.json.gz,
и приложение при первом запуске само подхватит память.

Если файлы больше 25 МБ и не загружаются через браузер GitHub — используй
tools/build-archive.html: он соберёт один сжатый архив, который весит в разы
меньше, и его уже можно загрузить в папку archive/.
