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

Рядом с текстом появляется персонаж выбранного тона (цундэрэ или яндэрэ) и «говорит», пока
звучит озвучка. Чтобы выставить источник до эфира, откройте в OBS
`https://APP_DOMAIN/overlay/?preview=tsundere` (или `yandere`): это пример карточки без токена
и без подключения. Картинки лежат в `apps/overlay/src/assets/`, исходники и скрипт вырезания
фона — в `assets/source/` и `apps/overlay/scripts/cutout.py`.

Не публикуйте overlay URL: query-параметр содержит секретный токен. Если ссылка
утекла, нажмите «Перевыпустить ссылку» в панели: старый токен перестаёт
работать, открытые оверлеи отключаются.
Автовоспроизведение иногда блокируется Browser Source; кнопка восстановления
на overlay позволяет запустить звук вручную.

## Владельцы и admin

`TWITCH_OWNER_IDS` — числовой Twitch user ID **владельца сервиса** (ваш), а не
стримеров; несколько через запятую. Это не логин. Узнать ID можно через Twitch
Helix `/users` с app/user token. Роль вычисляется при OAuth-входе; после изменения
списка владельцу нужно выйти и войти снова. Не назначайте владельцем общий
аккаунт и защищайте Twitch-аккаунт MFA. Ключ Anthropic тоже только ваш: он лежит
в `.env` сервера, стримеры его не видят и не вводят.

## Регистрация стримеров

Регистрация ручная. Стример входит через Twitch и получает статус «заявка»: панель
показывает «Ждём одобрения», бот на его канале не работает, ссылка оверлея не
выдаётся. В `/admin` → «Пользователи» заявки стоят первыми, кнопки «Одобрить» и
«Отклонить»; на «Обзоре» есть счётчик заявок. Второй способ — «Приглашения»: впишите
логин Twitch заранее, и этот логин войдёт без заявки (одноразово). Если стример
уже ждёт, приглашение одобряет его сразу. Все шаги пишутся в «Аудит»
(`user.signup`, `invite.create`, `user.activate`).

## Двухфакторная аутентификация

Вход — Twitch OAuth плюс TOTP-код (Google Authenticator, 1Password, Bitwarden).

- Владельцу 2FA **обязательна**: без неё `/admin` показывает мастер настройки, а
  все `/admin/*` отвечают `403 mfa_setup_required`. Код подтверждается при каждом
  входе через Twitch и повторно раз в 12 часов для админки. Отключить 2FA владельцу
  нельзя.
- Стримеру 2FA по желанию: «Включить 2FA» в шапке панели. Если включена, без кода
  после входа доступны только экран ввода кода и выход.
- При включении выдаются 8 одноразовых резервных кодов; их можно перевыпустить на
  странице «Безопасность».
- 5 неверных кодов подряд блокируют проверку на 15 минут; уже использованный код
  повторно не принимается.
- Секрет TOTP шифруется `TOKEN_ENCRYPTION_KEY`, резервные коды хранятся только как
  SHA-256.
- Стримеру, потерявшему телефон и коды, владелец сбрасывает 2FA в «Пользователях»
  («Сбросить 2FA»). Свою 2FA из интерфейса сбросить нельзя — это аварийная
  операция с доступом к серверу:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update users set
  totp_secret_ciphertext=null, totp_secret_iv=null, totp_secret_tag=null,
  totp_enabled_at=null, totp_last_step=null, mfa_recovery_hashes='{}',
  mfa_failed_attempts=0, mfa_locked_until=null where twitch_id='ВАШ_TWITCH_ID'"
```

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

## Сервер с общим Caddy (edge-режим): roast.recursia.online

Так RoastBot живёт на одном VPS с Purrse и IT Connect: порты 80/443 и TLS держит Caddy
из `purrse-web`, проекты общаются через Docker-сеть `edge`. RoastBot ничего не публикует на
хосте; его Caddy называется `roastbot-edge` и слушает `:8080` внутри `edge`. Файлы:
`deploy/docker-compose.edge.yml`, `deploy/Caddyfile.edge`, `deploy/edge-deploy.sh`.
Образы собираются на сервере по одному (параллельная сборка не помещается в 2 ГБ) и никогда
не скачиваются из реестра: у них префикс `localhost/` и `pull_policy: never`.

Замер на копии стека: в работе около 380 МиБ RAM вместе с загруженным голосом, сборка
шести образов — около 100 с на Mac (на 1 vCPU сервера ожидаемо в несколько раз дольше),
синтез фразы — 1–2 с при лимите в 1 CPU.

**Один раз:**

1. DNS: A-запись `roast` для `recursia.online` на IP сервера.
2. Twitch Developer Console: добавьте OAuth Redirect URL
   `https://roast.recursia.online/api/auth/twitch/callback`.
3. Доступ сервера к репозиторию — deploy key только на чтение:

   ```sh
   ssh-keygen -t ed25519 -N "" -C roastbot-deploy -f ~/.ssh/roastbot_deploy
   cat ~/.ssh/roastbot_deploy.pub   # GitHub → репозиторий → Settings → Deploy keys,
                                    # «Allow write access» не включать
   cat >> ~/.ssh/config <<'EOF'
   Host github-roastbot
     HostName github.com
     IdentityFile ~/.ssh/roastbot_deploy
     IdentitiesOnly yes
   EOF
   git clone git@github-roastbot:Degsteroz/twitch_speaker_bot.git /opt/roastbot
   ```

4. `cp deploy/.env.example deploy/.env && chmod 600 deploy/.env` и заполните по
   комментарию в начале файла. Все секреты генерируйте на сервере заново, не берите из
   локального `.env`.
5. В Caddyfile Purrse (`/opt/purrse/deploy/Caddyfile`) добавьте блок и пересоберите его
   `web` (сайты Purrse и IT Connect недоступны несколько секунд):

   ```caddyfile
   roast.recursia.online {
   	encode gzip
   	reverse_proxy roastbot-edge:8080
   }
   ```

   ```sh
   cd /opt/purrse && docker compose up -d --build web
   ```

**Запуск и каждое обновление:**

```sh
cd /opt/roastbot && ./deploy/edge-deploy.sh
```

Скрипт делает `git pull --ff-only`, собирает образы по одному, при первом запуске скачивает
голоса Piper с проверкой SHA-256 и поднимает стек; `migrate` применяет миграции до старта
сервисов. Проверка: `https://roast.recursia.online/health` и `/api/ready`.

`backup.sh` и `restore.sh` сами узнают edge-режим по контейнеру `roastbot-edge`.

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
останавливает API/worker/Twitch, восстанавливает архив в отдельную базу `<db>_restore` и
только после полного успеха подменяет ею рабочую. Прежняя база остаётся как
`<db>_previous` до следующего restore; при ошибке рабочая база не тронута. `pg_restore
--clean` поверх рабочей базы не используется: на секционированных таблицах pg-boss он
падает на середине и оставляет схему без индексов.

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

## Модерация и защита от инъекций

Каждый запрос проходит слои по порядку; первый сработавший останавливает роаст.

1. **Ник и сообщение** сверяются со встроенным списком (`packages/prompts/src/blocklist.ts`):
   мат, этнические, гомофобные и эйблистские оскорбления, самоповреждение, нацистские лозунги,
   14/88 и свастики. Перед сравнением текст нормализуется: регистр, `ё`, латинские и цифровые
   двойники (`пuд0р`), транслит (`pidor`, `nahuy`), leetspeak (`n1gg3r`), разбивка (`п и д о р`,
   `пи-дор`), маски (`п*дор`), повторы букв, приставки (`заебал`, `нахуй`), склеенные ники
   (`HeilHitler88`). Встроенный список отключить нельзя; слова из `/admin` и канала дополняют его.
2. **Попытка инъекции** («игнорируй инструкции», «повтори дословно», «ты теперь…», теги)
   отклоняется сразу: роаст-боту не нужно выполнять команды из чата. Квота и деньги не тратятся.
3. **Генерация**: правила только в системном промпте, ник и сообщение — экранированные данные в
   тегах, сообщение обрезается до 300 символов.
4. **Ответ** снова проходит список, затем проверку на ссылки и контакты, утечку промпта и
   дословный повтор шести и более слов из сообщения зрителя.
5. **Классификатор Haiku** получает ответ в теге `<reply>`; всё, кроме `ALLOW`, — блок.

Заблокированный ответ заменяется заглушкой и попадает в «Модерацию» в `/admin`. Известные
ложные срабатывания, оставленные ради надёжности: страна Нигер, фамилия Huynh.

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
- [ ] Новый пользователь входит через Twitch с точным scope и попадает в заявки.
- [ ] Одобрение и приглашение по логину открывают панель; отклонённый не работает.
- [ ] Twitch ID из `TWITCH_OWNER_IDS` видит owner/admin, обычный пользователь — нет.
- [ ] Админка не открывается без 2FA; код, резервный код и блокировка работают.
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
