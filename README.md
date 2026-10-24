# RoastBot

RoastBot — self-hosted Twitch-сервис: принимает команду в чате или активацию
награды Channel Points, безопасно генерирует короткий «роаст» через Anthropic,
озвучивает его локальным Piper и отправляет текст и звук в OBS Browser Source.

> Для агентов и разработчиков, которые открывают репозиторий впервые, есть
> подробное руководство [AGENTS.md](AGENTS.md): команды, инварианты и открытые вопросы.

## Архитектура

- `web` — React/Vite-панель стримера и владельца.
- `overlay` — Browser Source для OBS; получает события по WebSocket.
- `api` — Fastify API, OAuth Twitch, настройки, админка, подписанные аудиоссылки.
- `twitch` — IRC и EventSub WebSocket, обновление OAuth-токенов.
- `worker` — очередь pg-boss, лимиты, Anthropic, модерация, TTS и outbox.
- `tts` — FastAPI-обёртка над локальным Piper.
- `postgres` — PostgreSQL 16, данные приложения и очередь pg-boss.
- `caddy` — HTTPS и маршрутизация двух доменов.

Снаружи доступны только Caddy и два домена. PostgreSQL, TTS, web и overlay живут
только во внутренней Docker-сети без выхода в интернет; `api`, `worker` и
`twitch` дополнительно подключены к сети `egress`, потому что им нужны Twitch,
Anthropic и Telegram. Портов эта сеть не публикует. Общий volume `audio` используется API и worker, volume
`models` — TTS, данные PostgreSQL и Caddy хранятся отдельно.

## Требования

Для production: Linux x86_64/arm64, Docker Engine 24+, Compose v2, DNS A/AAAA
для `APP_DOMAIN` и `API_DOMAIN`, открытые 80/tcp, 443/tcp и 443/udp. До установки
желательно иметь не менее 2 ГиБ свободной RAM и 10 ГиБ диска. Лимиты контейнеров:
TTS 1 ГиБ/1 CPU, PostgreSQL 512 МиБ, API и worker по 512 МиБ; суммарная реальная
нагрузка зависит от модели и трафика.

Для разработки: Node.js 20+ (CI и образы используют 22), pnpm 10.18.3,
Python 3.12 и PostgreSQL 16. Проверка хоста ничего не меняет:

```sh
./deploy/preflight.sh
```

## Быстрый запуск production

1. Скопируйте `deploy/.env.example` в `deploy/.env` и замените все заглушки.
2. Создайте Docker volume моделей и поместите четыре файла Piper, описанные ниже.
3. Настройте Twitch-приложение и DNS.
4. Запустите:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

Одноразовый сервис `migrate` ждёт готовности PostgreSQL, применяет Drizzle-
миграции под session advisory lock и выполняет идемпотентный seed. API, worker
и Twitch не стартуют до его успешного завершения. Повторный `up` безопасен.

## Локальная разработка

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
```

Поднимите PostgreSQL 16 и TTS, затем скопируйте `.env.example` в `.env` в корне
репозитория и заполните. Этот файл не попадает в git; dev-скрипты `api`,
`worker`, `twitch` и `db:*` читают его сами (`--env-file`). Затем в разных
терминалах:

```sh
pnpm db:migrate
pnpm db:seed
pnpm --filter @roastbot/api dev
pnpm --filter @roastbot/worker dev
pnpm --filter @roastbot/twitch dev
pnpm --filter @roastbot/web dev
pnpm --filter @roastbot/overlay dev
```

Для локального OAuth задайте `PUBLIC_URL=http://localhost:3000`,
`DASHBOARD_URL=http://localhost:5173` и зарегистрируйте callback
`http://localhost:3000/auth/twitch/callback`. Twitch требует точного совпадения
callback, включая схему, порт и путь. В dev-режиме overlay открывается на
`http://localhost:5174/overlay/?token=…` и сам ходит в API на порт 3000.

## Локальное демо без Docker и Twitch

```sh
pnpm demo                     # фейковые ответы модели
ANTHROPIC_API_KEY=… pnpm demo # настоящий Haiku (или ключ из корневого .env)
```

Скрипт `scripts/demo.mjs` поднимает встроенный PostgreSQL, настоящие API и
worker, dev-серверы панели и оверлея. Вход без Twitch: `http://localhost:5175/login`,
затем панель `http://localhost:5173` и оверлей
`http://localhost:5174/overlay/?token=demo-overlay-token`. Вместо Piper звучит
macOS `say` (голос Milena), на других ОС — короткий сигнал. Чат и награды Twitch в
демо не подключены.

## Twitch Developer Console

В [Twitch Developer Console](https://dev.twitch.tv/console/apps) создайте
приложение категории Website Integration. OAuth Redirect URL должен быть ровно:

```text
https://APP_DOMAIN/api/auth/twitch/callback
```

Например, при `APP_DOMAIN=app.example.com`:
`https://app.example.com/api/auth/twitch/callback`. В `TWITCH_CLIENT_ID` и
`TWITCH_CLIENT_SECRET` скопируйте Client ID и новый Client Secret.

RoastBot запрашивает единственный scope:

```text
channel:read:redemptions
```

Он нужен для чтения наград и EventSub redemption. Публикация сообщений от имени
бота в v1 не используется. После изменения callback или scope войдите заново.

## Anthropic

Создайте API key в Anthropic Console и задайте `ANTHROPIC_API_KEY`. Установите
жёсткий месячный лимит расходов (для v1 рекомендуется $5) в самой консоли:
лимит приложения дополняет, но не заменяет лимит провайдера.

По умолчанию используется `claude-haiku-5-5` ($0.10 / $0.50 за 1M токенов на
вход/выход). `ANTHROPIC_MODEL` применяется только при первом seed; потом модель
меняется в `/admin` → «Глобальные». Генерация и классификатор вызываются с
`thinking: {type: "disabled"}` и без `temperature`: у Haiku 5.5 thinking включён
по умолчанию и съедает `max_tokens`, а sampling-параметры отклоняются с 400.
Выбирайте модель, которая принимает выключенный thinking (семейство Haiku/Sonnet).

Защита бюджета в приложении: kill switch, глобальный лимит роастов
(`global_monthly_limit`, 4000), денежный лимит (`monthly_budget_usd`, $5 —
стоимость считается по токенам каждого вызова, включая неудачные) и квота
канала по тарифу. При достижении любого лимита воркер не обращается к Anthropic,
роаст получает статус `skipped` с причиной, а дашборд показывает «лимит исчерпан».

## Piper и модели

TTS-образ содержит `piper-tts`, но модели намеренно не скачиваются при сборке.
Нужны файлы модели и конфигурации:

- `ru_RU-denis-medium.onnx`
- `ru_RU-denis-medium.onnx.json`
- `ru_RU-irina-medium.onnx`
- `ru_RU-irina-medium.onnx.json`

Скачивайте только из доверенного источника и сверяйте SHA-256. В репозитории
есть `services/tts/download_models.py`: он требует `DENIS_URL`,
`DENIS_SHA256`, `DENIS_CONFIG_URL`, `DENIS_CONFIG_SHA256`, а также аналогичные
`IRINA_*`, и отказывается принимать файл с неверной суммой. В `.env.example`
уже прописаны ссылки на тег `v1.0.0` репозитория `rhasspy/piper-voices` и их
SHA-256 (сняты 2026-10-23).

TTS загружает обе модели один раз при старте и держит их в памяти (~1 с экономии
на каждом запросе). Кэш WAV чистится от файлов старше
`TTS_CACHE_MAX_AGE_SECONDS`.

Колёса `piper-tts` для macOS arm64 (проверены 1.3.0–1.8.0) не находят данные
espeak-ng — падает даже штатный CLI `piper`. Локально на Mac используйте
Linux-контейнер; тесты TTS (`services/tts/tests`) подменяют голос и проходят везде.

Пример загрузки во временный контейнер, подключённый к production volume:

```sh
docker run --rm --env-file deploy/.env \
  -v roastbot_models:/models \
  --entrypoint python \
  ghcr.io/OWNER/roastbot-tts:TAG /service/download_models.py
```

Важно: лицензия голоса Irina не подтверждена для этого проекта. До
коммерческого использования самостоятельно найдите и сохраните условия лицензии
конкретных `.onnx` и `.onnx.json`; при сомнении не разворачивайте Irina и
замените `FEMALE_MODEL` на модель с проверенной лицензией. То же подтверждение
рекомендуется сохранить для Denis.

## Тур для стримера

При первом входе в панель открывается пошаговый тур: что означает каждый блок,
как включить награду за баллы, как подключить оверлей в OBS и как сделать тест.
Тур можно открыть снова кнопкой «Тур» вверху страницы; факт прохождения хранится
в `localStorage` браузера. Тексты шагов — `apps/web/src/tour-steps.ts`; при
переносе элемента в другое место обновите `data-tour` в `apps/web/src/main.tsx`,
иначе тест `apps/web/src/tour.test.ts` упадёт.

## OBS

1. Войдите в панель, откройте настройки канала и скопируйте полную overlay-ссылку.
2. OBS → Sources → `+` → Browser, вставьте URL, задайте 1920×1080.
3. Включите `Control audio via OBS`, направьте звук в нужную дорожку.

Не публикуйте overlay URL: query-параметр содержит секретный токен. Если ссылка
утекла, нажмите «Перевыпустить ссылку» в панели: старый токен перестаёт
работать, открытые оверлеи отключаются.
Автовоспроизведение иногда блокируется Browser Source; кнопка восстановления
на overlay позволяет запустить звук вручную.

## Владельцы и admin

`TWITCH_OWNER_IDS` — числовые Twitch user ID через запятую, не логины. Узнать ID
можно через Twitch Helix `/users` с app/user token. Роль вычисляется при OAuth-
входе; после изменения списка владельцу нужно выйти и войти снова. Не назначайте
владельцем общий аккаунт и защищайте Twitch-аккаунт MFA.

## Переменные окружения

Полный исполняемый шаблон находится в `deploy/.env.example`.

- Домены: `APP_DOMAIN`, `API_DOMAIN`, `ACME_EMAIL`; URL со схемой:
  `PUBLIC_URL`, `DASHBOARD_URL`, `TWITCH_REDIRECT_URI`.
- Образы: `GHCR_OWNER`, `IMAGE_TAG`.
- PostgreSQL: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `DATABASE_URL`. Пароль внутри URL должен быть percent-encoded.
- Twitch: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_OWNER_IDS`.
- Секреты: `SESSION_SECRET`, `AUDIO_SIGNING_SECRET`,
  `TOKEN_ENCRYPTION_KEY`.
- Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`.
- Piper: `MALE_MODEL`, `FEMALE_MODEL`, `TTS_CACHE_MAX_AGE_SECONDS`.
- Backup: `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_EXTERNAL_HOOK`.
- Existing proxy: `API_HOST_PORT`, `WEB_HOST_PORT`, `OVERLAY_HOST_PORT`.

`TOKEN_ENCRYPTION_KEY` — master key AES-256: ровно 32 случайных байта в виде
64 hex-символов (`openssl rand -hex 32`). Это не base64. Отдельной переменной
`MASTER_ENCRYPTION_KEY` код не читает. Не меняйте ключ после подключения
каналов: существующие Twitch-токены перестанут расшифровываться.
`SESSION_SECRET` и `AUDIO_SIGNING_SECRET` создаются независимо, например
`openssl rand -base64 48`.

Опциональный ежедневный Telegram-отчёт включается только если одновременно
заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. Worker отправляет отчёт в
09:00 по timezone контейнера (по умолчанию UTC). Оставьте обе переменные пустыми,
чтобы функцию отключить.

## Миграции и seed

Вручную локально:

```sh
DATABASE_URL=postgresql://... pnpm db:migrate
DATABASE_URL=postgresql://... ANTHROPIC_MODEL=claude-haiku-5-5 pnpm db:seed
```

Мигратор использует одну PostgreSQL-сессию и advisory lock, поэтому параллельные
деплои не применят миграции одновременно. Seed использует upsert/on-conflict и
может выполняться повторно. Никогда не генерируйте миграцию прямо на production;
сначала создайте и проверьте SQL в отдельной БД.

## Тесты

```sh
pnpm build          # сначала: тесты и type-aware lint читают workspace-пакеты из dist/
pnpm format:check
pnpm lint
pnpm test           # unit + интеграционные тесты на настоящем PostgreSQL 16
cd services/tts && python -m unittest discover -s tests -t .
```

Интеграционные тесты (`*.integration.test.ts`) поднимают одноразовый кластер
PostgreSQL 16 через `embedded-postgres` (`packages/testing`), применяют миграции
и seed и проверяют реальный SQL: квоты и подарки, кулдауны, kill switch и
денежный лимит, модерацию, outbox оверлея по WebSocket с подписанным аудио,
admin API и очередь pg-boss. Docker для них не нужен. Anthropic и TTS в тестах
подменяются.

GitHub Actions повторяет эти команды, затем собирает шесть production-образов.
На PR образы только собираются; на `main` публикуются в GHCR с тегами SHA и
`latest`. SSH deploy выполняется только для push в `main` и только когда заданы
secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`,
`GHCR_USER`, `GHCR_READ_TOKEN`. На сервере уже должны быть репозиторий и
заполненный `deploy/.env`.

## Production и существующий reverse proxy

Встроенный Caddy автоматически получает сертификаты для обоих доменов и
пересылает WebSocket без отдельной директивы. Не запускайте его, если 80/443 уже
заняты Caddy, Nginx или Traefik.

Для существующего host proxy:

```sh
docker compose --env-file deploy/.env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.existing-proxy.yml \
  up -d postgres migrate api worker twitch tts web overlay
```

На `APP_DOMAIN` отправляйте `/api/*` на `127.0.0.1:3000` со снятием `/api`,
WebSocket `/overlay/TOKEN` — на тот же API без снятия префикса, `/overlay/` —
на `127.0.0.1:8081` со снятием `/overlay`, остальные запросы — на
`127.0.0.1:8080`. `API_DOMAIN` можно направить прямо на `127.0.0.1:3000` для
отдельного health endpoint. Включите HTTPS и Upgrade/Connection для WebSocket.
Loopback-порты можно изменить в `.env`; Caddy этой командой не запускается.

## Backup и restore

```sh
./deploy/backup.sh
ROASTBOT_RESTORE_CONFIRM=restore-production \
  ./deploy/restore.sh deploy/backups/roastbot-YYYYMMDDTHHMMSSZ.dump
```

Backup использует custom/compressed `pg_dump`, атомарно переименовывает готовый
файл и удаляет архивы старше 7 дней. Для внешней копии задайте путь к
исполняемому `BACKUP_EXTERNAL_HOOK`; он получает путь архива первым аргументом.
Например, hook может выполнять `rclone copy "$1" remote:roastbot/`. Проверяйте
restore на отдельном окружении регулярно.

Restore требует явного guard, проверяет каталог архива через `pg_restore`,
останавливает API/worker/Twitch, выполняет clean restore и запускает сервисы
снова. Это разрушительная операция для текущей БД.

## Health и мониторинг

- API liveness: `https://APP_DOMAIN/health` (также `/api/health` и `https://API_DOMAIN/health`).
- API readiness: `https://APP_DOMAIN/api/ready` (или `https://API_DOMAIN/ready`).
- Внутренний TTS `/health` сообщает наличие обеих моделей.
- Состояние: `docker compose ... ps`.
- Логи: `docker compose ... logs -f --since=10m api worker twitch tts`.

Настройте внешний uptime-check на `/ready`. Docker-логи ограничены тремя файлами
по 10 МиБ на контейнер. Для расследования ошибок сопоставляйте API/worker логи с
таблицами `roasts` и `audit_log`; не отправляйте секреты и полный `.env` в
систему мониторинга.

## Безопасность и retention

- Все секреты храните только в `deploy/.env` с правами `chmod 600`; файл
  исключён из Docker build context.
- GHCR read token должен иметь только `read:packages`, deploy SSH key — отдельный
  непривилегированный пользователь с минимальным доступом к Docker.
- PostgreSQL, API и внутренние сервисы не публикуют порты в стандартном compose.
- OAuth state, HttpOnly/Secure cookie, шифрование Twitch-токенов и подписанные
  одноразовые по времени аудиоссылки уже включены.
- Worker каждые 10 минут обнуляет текст входа/выхода и сырые события чата
  (`events.raw`) старше 30 дней, чистит просроченный outbox и cooldown-записи и
  удаляет WAV старше 10 минут. Аудиоссылка подписывается в момент доставки в
  overlay и живёт 60 секунд.
- Backup хранится 7 дней по умолчанию. Внешнее хранилище должно иметь шифрование,
  отдельную retention-политику и проверенное удаление.
- Ограничьте firewall портами SSH/80/443, обновляйте host и образы, включите MFA
  в Twitch, GitHub и Anthropic.

## Диагностика

- `migrate` завершился с ошибкой: смотрите `docker compose ... logs migrate`;
  проверьте `DATABASE_URL`, доступность PostgreSQL и SQL миграции.
- TTS unhealthy: в volume нет `.onnx` или соседнего `.onnx.json`, имя не
  совпадает с `MALE_MODEL`/`FEMALE_MODEL`, либо volume недоступен для чтения.
- OAuth `redirect_mismatch`: callback в Twitch Console и
  `TWITCH_REDIRECT_URI` отличаются хотя бы одним символом.
- Бесконечный OAuth/нет cookie: проверьте HTTPS, `APP_DOMAIN`, системное время и
  что callback приходит прямо в API.
- Overlay не подключается: проверьте полный URL с token, сертификат API и
  WebSocket proxy; в OBS обновите Browser Source cache.
- Нет звука: проверьте TTS health, модели, `worker` logs и настройки аудио OBS.
- Нет наград: переподключите Twitch после выдачи scope, выберите reward ID в
  панели и проверьте `twitch` logs.
- `401` после ротации ключа: верните прежний `TOKEN_ENCRYPTION_KEY` либо
  переподключите все каналы.
- 80/443 заняты: не убивайте чужой proxy; используйте existing-proxy вариант.

## Ручная приёмка v1

- [ ] `preflight.sh` проходит, DNS и HTTPS корректны.
- [ ] Compose-сервисы healthy, `migrate` завершён с кодом 0.
- [ ] `/health` и `/ready` отвечают 200 извне.
- [ ] Новый пользователь входит через Twitch с точным scope.
- [ ] Twitch ID из `TWITCH_OWNER_IDS` видит owner/admin, обычный пользователь — нет.
- [ ] Сохраняются tone, voice, toxicity, cooldown и stop words.
- [ ] Тестовый roast проходит Anthropic → Piper → overlay и слышен в OBS.
- [ ] Команда чата создаёт roast; повтор блокируется cooldown.
- [ ] Выбранная Channel Points reward создаёт roast через EventSub.
- [ ] Stop word и output classifier блокируют запрещённый результат.
- [ ] Kill switch прекращает новые генерации.
- [ ] Месячные квоты и подарочная квота учитываются без гонки.
- [ ] Перезапуск API/worker/Twitch не теряет очередь и настройки.
- [ ] Backup создаётся, внешняя копия срабатывает, restore проверен на тестовой БД.
- [ ] Логи ротируются, uptime и опциональный Telegram-отчёт работают.
