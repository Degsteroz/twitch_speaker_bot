# План оптимизации RoastBot — задание для агента

Этот файл — пошаговое задание. Выполняй шаги строго по порядку, по одному.
Перед началом прочитай [AGENTS.md](../AGENTS.md) целиком: там инварианты, которые
нельзя ломать, и правила репозитория.

## Общие правила

1. **Не коммить, не делай `git add`, `commit`, `push`.** После каждого шага
   остановись и покажи пользователю `git diff`. Коммитит пользователь.
2. Один шаг — одно изменение. Не объединяй шаги, не делай «заодно».
3. После каждого шага с кодом запускай и прикладывай вывод:
   ```sh
   pnpm build && pnpm test && pnpm lint && pnpm format:check
   ```
   Все четыре команды должны пройти. Если тест упал — не правь тест под код,
   сначала разберись, почему.
4. Не трогай существующие миграции в `packages/db/migrations/`. Новая миграция —
   новый файл `NNNN_name.sql` + запись в `packages/db/migrations/meta/_journal.json`.
5. Не меняй промпты, стоп-лист и логику модерации (`packages/prompts`), кроме того,
   что явно сказано в шаге.
6. Никаких реальных ключей в коде, тестах и выводе. В `.env.example` только
   плейсхолдеры.
7. Если шаг невозможно выполнить так, как написано, — остановись и напиши, что
   именно мешает. Не придумывай обходной путь.
8. Текст в обратных кавычках в этом файле — имена из кода и логов, не инструкции.

## Контекст: что было найдено при ревью

- На каждый роаст делается два вызова Anthropic: генерация и классификатор
  (`services/worker/src/pipeline.ts`, функция `processRoast`). Оба по умолчанию
  идут на `claude-sonnet-5-5`.
- Параметры запроса формирует только `modelRequest()` в
  `services/worker/src/models.ts`. Для Sonnet 5.5 там включён thinking
  (`output_config: { effort: "low" }`, `max_tokens` 2000/1000). Классификатор
  отвечает одним словом, но платит за thinking.
- Классификатор получает system-промпт строкой, поэтому `cache_control` на него не
  ставится (см. `systemParam()` в `models.ts`) — промпт ~500 токенов оплачивается
  полностью на каждом вызове.
- На Sonnet 5.5 `thinking: { type: "disabled" }` возвращает 400, но есть
  `thinking: { type: "between_tools" }` — самый низкий уровень, extended thinking
  не выполняется. Принимается только на Sonnet 5.5 и только при `effort` ≤ `high`;
  внутри объекта `thinking` не должно быть других полей. Другие модели этот тип
  отвергают.
- Docker-образы api/worker/twitch (`services/*/Dockerfile`) копируют весь монорепо
  вместе с dev-зависимостями (`typescript`, `vitest`, `eslint`, `embedded-postgres`,
  `drizzle-kit`, `esbuild`). Образы в несколько раз больше нужного.
- Воркер обрабатывает по одной задаче за раз
  (`services/worker/src/index.ts`, `localConcurrency: 1`).
- pg-boss опрашивает очереди каждые 0.5 с при включённом `useListenNotify`.
- Запрос лимита зрителя в `reserve()` (`pipeline.ts`) фильтрует
  `roasts` по `channel_id`, `lower(viewer_login)`, `created_at`; индекса под
  `lower(viewer_login)` нет.

## Фаза 0. Базовая линия (только чтение)

### Шаг 0.1. SQL для статистики

Создай файл `scripts/baseline.sql` с запросами (только `select`):

```sql
-- Стоимость и число роастов по модели, источнику и тиру за 30 дней
select model, source, tier,
  count(*) roasts,
  round(avg(cost_usd)::numeric, 5) avg_usd,
  round(sum(cost_usd)::numeric, 2) total_usd,
  round(avg(latency_ms)) avg_ms,
  percentile_cont(0.95) within group (order by latency_ms) p95_ms
from roasts
where created_at > now() - interval '30 days' and status in ('done','blocked_output')
group by 1,2,3 order by total_usd desc;

-- Доля пропусков по причине
select error, count(*) from roasts
where created_at > now() - interval '30 days' and status='skipped'
group by 1 order by 2 desc;

-- Задержка по голосу
select voice_provider, count(*),
  percentile_cont(0.95) within group (order by latency_ms) p95_ms
from roasts where created_at > now() - interval '30 days' and status='done'
group by 1;
```

**Готово когда:** файл создан, `pnpm format:check` проходит. Код не меняется.

### Шаг 0.2. Доля кэша в сводке

Найди, где `/admin` показывает расход по моделям (ищи `cost_usd` в
`services/api/src/app.ts` и `apps/web/src/admin/`). `spendOf()` в
`pipeline.ts` уже считает `cacheRead`, но в `roasts` пишутся только
`tokens_in`/`tokens_out`. **Ничего не меняй в схеме.** Просто напиши в ответе,
где именно добавить колонку `cache_read_tokens` и в какой запрос, и остановись:
это решение пользователя.

## Фаза 1. Расход на Anthropic без изменения поведения

### Шаг 1.1. Классификатор по умолчанию — Haiku 5.5

Файлы:

- `packages/shared/src/index.ts`: `DEFAULT_CLASSIFIER_MODEL = "claude-haiku-5-5"`.
- `.env.example` и `deploy/.env.example`: `CLASSIFIER_MODEL=claude-haiku-5-5`.
- `packages/db/src/seed.ts`: seed читает `CLASSIFIER_MODEL`; убедись, что
  значение по умолчанию берётся из константы, а не захардкожено.
- `AGENTS.md`, инвариант 2: «классификатор (Sonnet 5.5)» → «классификатор
  (`classifier_model`, по умолчанию Haiku 5.5)».

Проверь, что для `claude-haiku-5-5` `modelRequest()` ставит
`thinking: { type: "disabled" }` и `max_tokens: 16` для `kind = "classify"` —
это уже должно быть так (`ALWAYS_THINKING` не матчит haiku). Добавь тест в
`services/worker/src/models.test.ts` (создай, если нет), который это фиксирует.

Важно: на работающем сервере значение хранится в `global_settings.classifier_model`
и меняется в `/admin`; seed идемпотентен и существующее значение не перепишет.
Напиши это пользователю в ответе.

**Готово когда:** тесты и lint зелёные, в diff нет других файлов.

### Шаг 1.2. Оценка классификатора на Haiku (скрипт, не запускать самому)

Создай `scripts/classifier-eval.mjs`:

- читает `ANTHROPIC_API_KEY` из окружения; без ключа печатает подсказку и выходит;
- импортирует из `packages/prompts/dist/index.js`: `classifierSystemPrompt`,
  `classifierInput`, `parseClassifierVerdict`, и из `packages/prompts/src/index.test.ts`
  **не импортирует** (это тест); вместо этого вынеси массивы примеров
  `MUST_BLOCK` и `MUST_ALLOW` в `packages/prompts/src/examples.ts`, экспортируй
  их и используй из теста и из скрипта. Содержимое массивов не менять;
- для каждого примера и каждого уровня токсичности 1–6 вызывает две модели
  (`--old claude-sonnet-5-5 --new claude-haiku-5-5`) через `modelRequest()` из
  `services/worker/dist/models.js`;
- печатает таблицу: пример, уровень, вердикт старой, вердикт новой;
- в конце: число расхождений, и отдельно — случаи, где старая `block`, а новая
  `allow` (это критичные пропуски).

Критерий приёмки (пользователь запускает сам): критичных пропусков — 0,
расхождений на `MUST_ALLOW` — не более 3 %. Если не выполняется — шаг 1.1
откатить (`DEFAULT_CLASSIFIER_MODEL` обратно) и написать пользователю.

**Готово когда:** скрипт создан, `node scripts/classifier-eval.mjs` без ключа
печатает подсказку и завершается с кодом 0, тесты зелёные.

### Шаг 1.3. `between_tools` для Sonnet 5.5

Файл `services/worker/src/models.ts`. Добавь:

```ts
// Sonnet 5.5 cannot take `disabled`, but `between_tools` is its lowest setting:
// no extended thinking, so a one-line reply needs no headroom for it.
const BETWEEN_TOOLS = /^claude-sonnet-5-5/u;
```

В `modelRequest()`:

- если `BETWEEN_TOOLS.test(model)`: `thinking: { type: "between_tools" }`,
  `max_tokens: MAX_TOKENS[kind].plain`, без `output_config`;
- иначе — как сейчас.

Если тип SDK (`@anthropic-ai/sdk` 0.137) не знает `between_tools`, передай
объект через `as unknown as ModelRequest["thinking"]` с комментарием в одну
строку. Не обновляй SDK в этом шаге.

Обнови комментарий в начале файла: он утверждает, что на Sonnet 5.5 thinking
нельзя выключить — теперь это неверно.

Тесты в `models.test.ts`:

- `claude-sonnet-5-5` + `generate` → `thinking.type === "between_tools"`,
  `max_tokens === 300`, нет `output_config`;
- `claude-opus-5-5` → по-прежнему `output_config.effort === "low"`,
  `max_tokens === 2000`;
- `claude-haiku-5-5` → `thinking.type === "disabled"`.

`temperature` по-прежнему не передаётся никогда (инвариант 3).

**Готово когда:** тесты зелёные. Напиши пользователю, что нужен один живой
вызов для проверки (`pnpm demo` с настоящим ключом, тест-роаст из панели) —
сам не вызывай.

### Шаг 1.4. Кэш для промпта классификатора

Сейчас `classifierSystemPrompt(toxicity)` в `packages/prompts` возвращает строку.
Сделай так, чтобы промпт классификатора передавался в `modelRequest()` как массив
блоков (`readonly string[]`): первый блок — общая часть, одинаковая для всех
уровней; последний — часть, зависящая от `toxicity`. Если промпт не делится
естественно, оставь один блок **и всё равно передай массив из одного элемента**
— тогда `systemParam()` не поставит `cache_control` (у него breakpoint на всех
блоках, кроме последнего), и это надо учесть: в таком случае добавь второй
блок с короткой инструкцией формата ответа.

Текст промпта **не менять** — только разбить на части так, чтобы `join("\n")`
давал ровно прежнюю строку. Добавь тест, который это проверяет.

Обнови три места вызова: `pipeline.ts` (роаст и `draftCaption`) и
`demo.ts`.

**Готово когда:** тест на равенство строки проходит, тесты зелёные.

## Фаза 2. Инфраструктура

### Шаг 2.1. Опрос pg-boss

`services/worker/src/index.ts`: `pollingIntervalSeconds: 0.5` → `2`.
Уведомления (`useListenNotify: true`) доставляют задачи сразу; опрос — страховка.
Если есть интеграционный тест на pg-boss, он должен остаться зелёным.

**Готово когда:** одна строка в diff, тесты зелёные.

### Шаг 2.2. Один production-образ для Node-сервисов

Создай `deploy/node.Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @roastbot/api... --filter @roastbot/worker... --filter @roastbot/twitch... build \
 && pnpm --filter @roastbot/api --filter @roastbot/worker --filter @roastbot/twitch \
      --prod deploy --legacy /out
RUN chmod -R a+rX /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data/audio && chown -R node:node /data
USER node
# command is set per service in docker-compose
```

Если `pnpm deploy` с несколькими `--filter` не поддерживается вашей версией pnpm
(10.18.3) — остановись и напиши. Не придумывай другую схему.

В `deploy/docker-compose.yml`, `docker-compose.edge.yml`,
`docker-compose.existing-proxy.yml`:

- `api`, `worker`, `twitch`, `migrate` → один `image: ghcr.io/${GHCR_OWNER}/roastbot-node:${IMAGE_TAG:-latest}`,
  `build.dockerfile: deploy/node.Dockerfile`;
- `command` каждого: `node services/<name>/dist/index.js` (проверь пути после
  `deploy` — они могут отличаться, посмотри содержимое `/out`);
- `migrate` остаётся `node packages/db/dist/migrate.js && node packages/db/dist/seed.js`.

Обнови `deploy/edge-deploy.sh` и `.github/workflows/*` (если там сборка образов)
под один образ. Старые `services/*/Dockerfile` удали.

Проверка (на машине пользователя, Docker нужен):

```sh
docker compose -f deploy/docker-compose.yml build
docker images | grep roastbot
```

Покажи пользователю размеры до и после. Сквозная проверка — репетиция в
edge-режиме по README; сам не запускай, если пользователь не попросил.

**Готово когда:** сборка проходит, все три сервиса стартуют, healthcheck зелёный.

### Шаг 2.3. Лимиты памяти

Только после того, как пользователь пришлёт `docker stats` с сервера. Не
угадывай. Ориентиры: `tts` 1g → 384m, `api`/`worker` 512m → 384m, если по
статистике потребление вдвое ниже лимита.

## Фаза 3. Пропускная способность

### Шаг 3.1. Индекс под лимит зрителя

Новая миграция `packages/db/migrations/NNNN_viewer_limit_index.sql`:

```sql
CREATE INDEX "roasts_channel_viewer_created_idx"
  ON "roasts" ("channel_id", lower("viewer_login"), "created_at");
```

Запись в `_journal.json` по образцу предыдущих. Миграции не редактировать.

**Готово когда:** `pnpm db:migrate` на тестовой БД проходит, интеграционные
тесты зелёные.

### Шаг 3.2. Параллельная обработка в воркере

`services/worker/src/index.ts`: для `ROAST_REQUESTED_QUEUE`
`localConcurrency: 1` → `4`. Демо-очередь оставь `1`.

Добавь интеграционный тест в `pipeline.integration.test.ts`: 10 задач одного
канала с квотой 5 запускаются через `Promise.all` → ровно 5 `done`, 5
`skipped` с `channel_quota_exceeded`, `usage_monthly.roasts = 5`. Это проверка
инварианта 4 (резерв под advisory lock).

**Готово когда:** новый тест зелёный, остальные тоже.

### Шаг 3.3. Очистка батчами

`packages/db/src/cleanup.ts`: каждый `update`/`delete` ограничить подзапросом
`where id in (select id ... limit 5000)` и крутить в цикле, пока затронуто
5000 строк. Результат (`CleanupResult`) суммировать. Поведение то же, нагрузка
на большой таблице — ровнее.

**Готово когда:** существующие тесты очистки зелёные, добавлен тест на

> 5000 строк (можно с меньшим порогом через параметр).

## Фаза 4. Не для агента

Решения владельца, без кода: цены тарифов, бесплатный лимит, алерт на 70 %
бюджета, выключение демо (`demo_daily_limit = 0` в `/admin`). Агент к этой
фазе не приступает.

## Фаза 5. Поддерживаемость (только по отдельной просьбе)

- Выбор модели из тернарника в `processRoast` → чистая функция `pickModel()` с
  табличным тестом. Поведение не менять.
- `services/api/src/app.ts` разрезать на модули по маршрутам. Контракты и
  тесты не менять.
- Решить судьбу `monthly_tts_limit` (см. AGENTS.md §9).

## Стоп-сигналы

Остановись и напиши пользователю, если:

- после 1.1 или 1.3 в тест-роастах заметно изменились тексты (длиннее,
  ломается уровень токсичности, появились теги `<thinking>` в ответе);
- любой интеграционный тест стал нестабильным (падает через раз);
- шаг требует правки промптов или стоп-листа;
- `pnpm deploy` или сборка образа не работает так, как описано.
