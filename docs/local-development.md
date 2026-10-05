# Локальный запуск Isaac

Эта инструкция поднимает полный локальный сервис: интерфейс, чат-движок, биллинг,
базы данных, шлюз моделей и списание кредитов. Она предназначена для Windows-разработчиков;
секреты и файлы `.env` в Git не добавляются.

## Что потребуется

- Windows 10/11 с PowerShell;
- Git;
- Docker Desktop (запущенный до старта);
- Bun: <https://bun.sh>;
- доступ к двум репозиториям: `GlebAvershin/paragraf-monorepo` и
  `GlebAvershin/paragraf-gateway`;
- значения для `paragraf-gateway/.env` от ответственного за инфраструктуру.

## Подготовка папок

Клоны должны лежать рядом:

```text
D:\TEMKA\                 # paragraf-monorepo
D:\paragraf-gateway\      # paragraf-gateway
```

Если репозитории ещё не скачаны:

```powershell
git clone https://github.com/GlebAvershin/paragraf-monorepo.git D:\TEMKA
git clone https://github.com/GlebAvershin/paragraf-gateway.git D:\paragraf-gateway
```

В шлюзе создайте локальный файл настроек:

```powershell
Copy-Item D:\paragraf-gateway\.env.example D:\paragraf-gateway\.env
```

Заполните только полученные от команды значения в `D:\paragraf-gateway\.env`.
Для работы моделей нужен как минимум один корректный провайдер; для текущего продукта
обычно настраивают `GIGACHAT_CREDENTIALS` и/или `YANDEX_FOLDER_ID` с `YANDEX_API_KEY`.
Не пересылайте и не коммитьте этот файл.

Для связки сервисов также нужны два общих значения. Скрипт запуска автоматически
перенесёт `LITELLM_MASTER_KEY` из шлюза в `D:\TEMKA\billing\.env`, если там пусто.
Если в `D:\paragraf-gateway\app\.env` включена проверка `GATEWAY_API_SECRET`, то
то же значение должно быть указано в `D:\TEMKA\engine\.env`. Для первого локального
запуска оба значения секрета можно оставить пустыми только в изолированной среде разработки.

## Запуск на Windows

Откройте обычный PowerShell и выполните:

```powershell
cd D:\TEMKA
.\up.ps1
$env:PATH = "C:\Users\Home\.bun\bin;$env:PATH"
bun run --cwd D:\TEMKA\web dev:web
```

`up.ps1` поднимает Docker-контейнеры LiteLLM, engine и billing, создаёт локальные
настройки при их отсутствии, применяет миграции, запускает gateway-app, billing,
чат-движок и ETL-воркер. Окна сервисов оставьте открытыми:
в окне billing появляется одноразовый код для входа.

Последняя команда запускает сайт. Откройте адрес, который напечатает Vite в терминале.
Обычно это `http://127.0.0.1:5173`; если порт занят, Vite выберет следующий свободный.

## Быстрая проверка

После запуска должны отвечать:

```powershell
Invoke-WebRequest http://localhost:4000/health/liveliness
Invoke-WebRequest http://localhost:4100/health/readiness
Invoke-WebRequest http://localhost:3000/health/readiness
Invoke-WebRequest http://localhost:4096/health/readiness
```

В браузере запросите код входа для заранее созданного тестового пользователя. Код
появится в отдельном окне billing. Затем создайте диалог и отправьте короткий запрос
к доступной модели. Если ответ не приходит, сначала проверьте заполнение
`D:\paragraf-gateway\.env` и статус четырёх адресов выше.

## Остановка

Остановите Vite сочетанием `Ctrl+C` в его терминале, затем выполните:

```powershell
cd D:\TEMKA
.\down.ps1
```

Контейнеры Docker и их данные останутся запущенными. Чтобы остановить и их:

```powershell
.\down.ps1 -Docker
```

## Частые проблемы

- **Docker Desktop был перезапущен.** Повторите `D:\TEMKA\up.ps1`: контейнеры после
  перезагрузки Docker могут быть остановлены.
- **Модели не отвечают.** Не публикуйте ключи в чате. Проверьте, что шлюзный `.env`
  заполнен и `http://localhost:4000/health/liveliness` отвечает успешно.
- **Не приходит код входа.** В локальном режиме код печатается в отдельном окне
  billing; это нормально, если SMTP не настроен.
- **Порт сайта отличается от 5173.** Используйте адрес, который вывел Vite: занятой
  порт автоматически меняется.
