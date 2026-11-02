# HANDOFF: голоса, тарифы и упрощение (RoastBot)

Документ переносит контекст разговора с другой машины, чтобы продолжить работу без старта с нуля.
Дата: 2026-10-29. Файл не коммитить (правила проекта и владельца ниже).

---

## 0. Как начать на новой машине

```sh
git fetch && git checkout main && git pull --ff-only   # нужен коммит ea6de43 или новее
pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint
```

Исходная точка на `ea6de43`: сборка и lint проходят, **377 тестов зелёные**.

Прочитать до правок: `AGENTS.md` целиком, затем файлы из раздела 4.

**Правила владельца:**

- не делать `git add/commit/push`, только предлагать одну строку коммита в формате `TYPE(APP): CHANGES`;
- `BACKLOG.md` — личный файл владельца, в git не попадает;
- прод работает на слабом VPS, не добавлять нагрузку (лишние контейнеры, частые фоновые задачи).

**Осторожно:** AGENTS.md на `ea6de43` мог устареть относительно кода. Аудит на старой машине делался
против старого `main` (1dd77b5), его результаты неприменимы, сверку нужно повторить.

---

## 1. Откуда всё взялось: сравнение TTS (чат с ChatGPT)

Владелец сравнивал TTS для бота, который голосом отвечает в чате Twitch. Цены по публичным тарифам на 2026-10:

| Сервис              | Цена                                                                       | Качество (оценка владельца)     |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| Yandex SpeechKit    | v1 ≈ $11 / 1 млн символов; v3 — 0,1626 ₽ за запрос до 250 символов         | роботизированно, но почти даром |
| Inworld TTS-2 Flash | $15 / 1 млн символов On-Demand, первые до 70 мин бесплатно, 5 параллельных | хорошо                          |
| Cartesia            | Pro $5/мес за 100k кредитов, сверх лимита $65/1 млн                        | хорошо, но дороже Inworld       |
| ElevenLabs Flash/v4 | $0,05–0,08 / 1000 символов                                                 | лучше всех, но дорого           |

Вывод ChatGPT: **Inworld TTS-2 Flash — основной голос**, Яндекс — дешёвый запасной. Тарифы по ChatGPT:

| Тариф   | Цена       | Роастов хорошим голосом            | После квоты                   |
| ------- | ---------- | ---------------------------------- | ----------------------------- |
| Free    | $0         | (по ChatGPT 100 локальным голосом) | ждать следующего месяца       |
| Basic   | $5.99/мес  | 500                                | Яндекс, бот остаётся на связи |
| Premium | $11.99/мес | 1000                               | Яндекс                        |

Расчёт ChatGPT предполагал текст на Haiku. В коде сейчас генерация на **Sonnet 5.5** (миграция 0018),
слова в чате на Haiku 5.5, классификатор Sonnet 5.5. Оценка «роаст хорошим голосом ≈ $0,007, Яндексом
≈ $0,004» приблизительная: пересчитать по реальным `roasts.cost_usd` на проде.

**ElevenLabs:** за 5 дней ушло 60% месячных символов, осталось 40% (при той же скорости хватит
примерно на 3 дня). Лимит общий на весь сервис (`elevenlabs_monthly_char_limit`, 70 000, плюс
синхронизация с подпиской ElevenLabs в `services/worker/src/elevenlabs.ts`).

---

## 2. Решения владельца (зафиксированы)

1. **Цепочка голосов: ElevenLabs → Inworld → Яндекс**, каждый в пределах своего месячного лимита.
   ElevenLabs пока оставляем, пусть остаток догорит; потом переходим на Inworld (ключ ElevenLabs можно
   просто убрать).
2. **Piper (`services/tts`) остаётся, но только аварийным**: звучит, лишь если отказали ВСЕ облачные
   голоса. Ни один тариф и ни один override не может выбрать Piper как свой голос. Контейнер и деплой
   Piper не трогаем.
3. **Тарифы по ChatGPT, цена такая, что ПОКУПАТЕЛЬ платит $5.99 / $11.99.** Звезда для покупателя
   ≈ $0,02, значит Basic ≈ **300 ⭐**, Premium ≈ **600 ⭐** за 30 дней. Нам после вывода ≈ $0,0124 за
   звезду (`USD_PER_STAR`), то есть ≈ $3,7 / $7,4.
4. **После квоты хорошего голоса — Яндекс с потолком**, дальше стоп до следующего месяца. Предложено
   Basic +200, Premium +500. Владелец выбрал вариант «Яндекс с потолком», точные числа не уточнял;
   +200/+500 пока рабочие.
5. **Free получает пробные роасты хорошим голосом**: «должна быть возможность посмотреть на что-то
   хорошее». Всего 100 роастов в месяц (как у ChatGPT), из них N хорошим голосом, остальные Яндексом.
   **N не решено** (сейчас в коде 2). Спросить владельца, предложить 10–20.
6. **Героини:**
   - Мицуки (`tsundere`) и Аи (`yandere`) **не трогаем**.
   - У героинь, которых создали Premium-пользователи (таблица `characters`), голос из списка ElevenLabs
     (`voices`). Все кастомные голоса **меняем на голос Аи** (yandere).
   - Затем составляем **новый список голосов из Inworld**, и стримеры выбирают из него.
7. **Прозрачность для стримера:** одна понятная строка вроде «Basic: 500 роастов хорошим голосом,
   потом ещё 200 голосом попроще. Сейчас 120 из 500». Без снисходительного тона, не «как для тупых».
8. **Админка:** на виду бюджет ($), лимит Яндекса (₽), kill switch и таблица тарифов из трёх чисел:
   хороший голос, потом Яндекс, цена ⭐. Выбор моделей, лимиты символов по провайдерам и колонки
   «Модель потом» / «Голос потом» уходят в **свёрнутый блок «Дополнительно»**, но не удаляются.
   Владелец жалуется, что «тонкие настройки сложные ужасно».

### Что нужно от владельца для подключения Inworld

- `INWORLD_API_KEY`: ключ с platform.inworld.ai. В портале он уже в Base64, вставлять как есть, уходит в
  `Authorization: Basic <key>`.
- ID голосов Inworld: на Мицуки и Аи (`INWORLD_VOICE_TSUNDERE` / `INWORLD_VOICE_YANDERE`) и новый
  список голосов для кастомных героинь.
- `INWORLD_MODEL` по умолчанию `inworld-tts-2-flash`, трогать не нужно.
- Всё это в `deploy/.env` (права 600), потом деплой.

---

## 3. Inworld API (проверено по документации, вживую не вызывалось)

- `POST https://api.inworld.ai/tts/v1/voice`
- Заголовки: `Authorization: Basic <INWORLD_API_KEY>`, `Content-Type: application/json`
- Тело: `{ text, voiceId, modelId: "inworld-tts-2-flash", audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000 } }`.
  `LINEAR16` в непотоковом ответе приходит с WAV-заголовком.
- Ответ JSON: `{ audioContent: "<base64>", usage: { processedCharactersCount, modelId } }`
- Текст до 2000 UTF-16 code units. Модели: `inworld-tts-2` и `inworld-tts-2-flash` (TTFB P90 20 мс).
- Есть поле `language` (BCP-47), но поддержка русского и список русских голосов в доках закрыты
  логином. Поэтому `language` не передавали; проверить на живом ключе.
- Цена Flash: On-Demand $15/1 млн символов (первые до 70 мин бесплатно, 5 параллельных); Creator $25/мес
  → $10/1 млн, 10 параллельных.

**Готовый образец кода (под старый main):** на старой машине он лежит в `git stash@{0}` и в патче.
На эту машину они не переедут, поэтому суть здесь:

```ts
// services/worker/src/tts.ts
export const INWORLD_USD_PER_CHARACTER = 15 / 1_000_000;
const INWORLD_URL = "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUDIO_CONFIG = { audioEncoding: "LINEAR16", sampleRateHertz: 24_000 } as const;
const INWORLD_TIMEOUT_MS = 4_000;

async function synthesizeInworld(text, voiceId, config, fetcher): Promise<Uint8Array> {
  const response = await fetcher(INWORLD_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.INWORLD_API_KEY!}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voiceId,
      modelId: config.INWORLD_MODEL,
      audioConfig: INWORLD_AUDIO_CONFIG
    }),
    signal: AbortSignal.timeout(INWORLD_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`inworld_tts_${response.status}`);
  const { audioContent } = (await response.json()) as { audioContent?: string };
  if (!audioContent) throw new Error("inworld_tts_empty");
  return new Uint8Array(Buffer.from(audioContent, "base64"));
}
```

В старой реализации было:

- блок Inworld в `speak()` между ElevenLabs и Яндексом: резерв символов → вызов → при ошибке следующий
  голос, `fallbackReason = "inworld_tts_monthly_limit"`, если резерв не прошёл;
- `VOICE_ORDER = ["elevenlabs", "inworld", "yandex", "piper"]`;
- общий `reserveCharacters(sql, provider, now, characters, limit)` для ElevenLabs и Inworld (upsert в
  `tts_usage_monthly`, provider `inworld`);
- настройка `inworld_monthly_char_limit`, по умолчанию 500 000 (≈ $7,50), в seed, в схеме admin-настроек
  API, на «Обзоре» и в «Голосах»;
- env `INWORLD_API_KEY`, `INWORLD_MODEL`, `INWORLD_VOICE_TSUNDERE`, `INWORLD_VOICE_YANDERE` в `config.ts`,
  `.env.example`, `deploy/.env.example`, `deploy/docker-compose.yml`;
- `economyVoiceSchema = ["inworld", "yandex"]` (без piper) и миграция piper → yandex с заменой CHECK;
- интеграционный тест: ElevenLabs на лимите → Inworld (URL, заголовок, тело, WAV на диске, стоимость,
  резерв) → Inworld на лимите → Яндекс. Мок ответа:
  `new Response(JSON.stringify({ audioContent: Buffer.from("RIFF").toString("base64") }))`.
  Важно: `audioFile` лежит в `overlay_events.payload`, а не в `roasts`. После теста вернуть лимиты в
  `global_settings`, иначе следующие тесты падают.

---

## 4. Карта актуального кода (ea6de43), то, что затрагивает задачу

**Голоса (worker):**

- `services/worker/src/tts.ts`
  - `speak()`, порядок `VOICE_ORDER = ["elevenlabs","yandex","piper"]`;
  - `CHARACTER_VOICES`: Яндекс-голос на каждый из 5 архетипов (tsundere, yandere, kuudere, dandere, himedere);
  - `elevenLabsVoiceFor(tone, config, customVoice)`;
  - опции `best`, `piper`, `voiceId` (голос кастомной героини, null — нет), `yandex`, `elevenLabsTimeoutMs`;
  - `releaseElevenlabs` возвращает символы при HTTP-ошибке ElevenLabs.
- `services/worker/src/limits.ts`
  - `reserve()` и `bookTier()`: премиум-квота `usage_monthly.premium_roasts` против `plans.premium_roasts`;
  - месячный лимит канала плюс `gifted_quota`;
  - `reserveYandexRequests`, `reserveElevenLabsCharacters`;
  - `voiceReservations(deps)`: сюда добавить Inworld.
- `services/worker/src/elevenlabs.ts`: синхронизация расхода и лимита с подпиской ElevenLabs
  (`elevenlabs_subscription` в `global_settings`), `elevenLabsCharLimit()`.
- `services/worker/src/voices.ts`
  - `recordVoiceSample`: сэмпл голоса для панели, только ElevenLabs;
  - `syncVoices`: при старте добавляет голоса Мицуки и Аи из env в `voices` («Как у Мицуки», «Как у Аи»).
- `services/worker/src/stubs.ts`: заранее записанные заглушки кэшируются в `stub_audio` по ключу
  `elevenlabs:<voiceId>`. Нужен ключ и для Inworld (например, `inworld:<voiceId>`).
- `services/worker/src/pipeline.ts` (~строка 303): вызов `speak(... { best: tier === "premium" ? "elevenlabs" : context.economyVoice, voiceId: character.voiceId })`.
- `services/worker/src/context.ts`: `characterVoiceId` из `voices`, join `left join voices v on v.id=ch.voice_id and v.enabled`.

**Героини и голоса (БД, миграции 0016–0017):**

- `voices(id text PK, label, description, enabled, sort, sample bytea, sample_status)`:
  CHECK `id ~ '^[A-Za-z0-9]{10,40}$'`, по сути только ElevenLabs. Для Inworld нужен `provider`
  (или отдельная колонка или таблица) и проверка формата ID Inworld.
- `characters(..., archetype tone, voice_id → voices.id ON DELETE SET NULL, status private|pending|published|rejected)`.
- `0017_elevenlabs_voices.sql` засевает 5 голосов ElevenLabs («Голос 1..5»).
- `CUSTOM_CHARACTER_PLANS = {"premium"}` в `packages/shared`.

**Тарифы:**

- `packages/db/src/seed.ts` сейчас:
  - free: 10 роастов, `premiumRoasts` 2 (`FREE_PREMIUM_ROASTS`);
  - basic: 300 роастов, 50 премиум, 170 ⭐;
  - premium: 1500 роастов, 300 премиум, 900 ⭐;
  - upsert seed обновляет только `monthly_roast_limit` и `monthly_tts_limit`. Цена, премиум и
    economy-поля задаются в `/admin`, менять их через миграцию по образцу `0015_cheaper_plans.sql`
    (обновлять только старые дефолты).
- `DEFAULT_CHANNEL_MONTHLY_ROASTS = 10`, `COMMAND_PLANS = {basic, premium}`, `BRANDED_PLANS = {free}`.
- `economyVoiceSchema = ["yandex","piper"]` в `packages/shared`:
  - тот же CHECK в `plans` (миграция 0012, `schema.ts`);
  - CHECK в `channel_overrides_voice_check` (миграция 0019);
  - override-форма в `apps/web/src/admin/users.tsx` (~строки 560–580).
- Модель «тарифа» сейчас: `monthly_roast_limit` = всего роастов (жёсткий стоп), `premium_roasts` =
  сколько из них хорошими. Под решение п. 4 «500 хороших + 200 Яндексом» это ложится как
  `premium_roasts=500`, `monthly_roast_limit=700`.

**Где стример видит тариф:**

- `apps/web/src/dashboard/billing.tsx`: карточка «Тариф», текст «N роастов в месяц, из них M на
  лучшей модели и голосе, остальные попроще»; на Free захардкожено «10 роастов».
- `apps/web/src/dashboard/index.tsx` (~строка 330): «Лучшая модель и голос: осталось X из Y…».
- `services/api/src/dashboard.ts` (~строка 285): отдаёт `premium: { total, remaining }`.
- `services/api/src/telegram-bot.ts` (~строка 26): тот же текст тарифа для Telegram.
- `apps/web/src/roast-page.tsx`: `TIER_TEXT`, `VOICE_TEXT`.

**Админка:**

- `apps/web/src/admin/settings.tsx`:
  - группы «Лимиты и бюджет», «Регистрация», «Модели» (model, chat_model, classifier_model),
    «Голоса» (ElevenLabs, Яндекс), kill switch;
  - заметка «последним — бесплатный Piper» устарела.
- `apps/web/src/admin/plans.tsx`: колонки «Цена ⭐», «Роастов в месяц» (только чтение, задаёт seed),
  «Лучших», «Модель потом», «Голос потом» (опция Piper).
- `apps/web/src/admin/characters.tsx`: модерация героинь и список голосов.
- `apps/web/src/admin/overview.tsx`: метрики ElevenLabs и Яндекса.
- API: `services/api/src/admin.ts` (настройки, тарифы), `services/api/src/characters.ts`.

---

## 5. План работ (предложен, владелец сказал «давай»)

1. **Inworld в цепочку**: ElevenLabs → Inworld → Яндекс → (аварийный Piper).
   - Код по образцу из раздела 3, но в новые `tts.ts`, `limits.ts`, `stubs.ts`.
   - Голоса Мицуки и Аи для Inworld берутся из env.
2. **Piper только аварийный**:
   - убрать `piper` из `economyVoiceSchema`, из override (`channel_overrides`) и из UI;
   - миграция `0022_*`: `piper` → `yandex` в `plans` и `channel_overrides`, затем пересоздать оба CHECK
     (`plans_economy_voice_check`, `channel_overrides_voice_check`). Возможно, `inworld` стоит разрешить
     как economy-голос, решить вместе с владельцем.
3. **Голоса кастомных героинь**:
   - миграция: у всех `characters`, чей `voice_id` указывает на голос ElevenLabs, кроме голосов Мицуки и
     Аи, поставить голос Аи. Голос Аи — это `ELEVENLABS_VOICE_YANDERE` из env, в БД это строка `voices`
     с label «Как у Аи». Внимательно: ID берётся из env, в миграции его может не быть. Вариант —
     одноразовое действие воркера при старте.
   - затем `voices` расширить под Inworld (provider) и завести список голосов Inworld, который даст
     владелец. Сэмплы голосов через `speak()` с `best: "inworld"`.
4. **Тарифы по ChatGPT** (миграция по образцу 0015 плюс seed):
   - Free: 100 всего, N хороших (N спросить);
   - Basic: 500 хороших, всего 700, 300 ⭐;
   - Premium: 1000 хороших, всего 1500, 600 ⭐.
   - Обновить захардкоженные тексты (billing Free «10 роастов», лендинг, тур, README).
   - Проверить экономику по реальным `cost_usd`.
5. **Прозрачный текст для стримера** в billing, на дашборде и в Telegram-боте: «N роастов хорошим
   голосом, потом ещё M голосом попроще», сколько осталось.
6. **Админка «Дополнительно»**: на виду бюджет, лимит Яндекса, kill switch и тарифы (хорошие / потом
   Яндекс / ⭐). Модели, лимиты символов ElevenLabs/Inworld, «модель/голос потом» — в свёрнутом блоке.
7. **Документация**: AGENTS.md (инвариант про платные голоса и резерв, цепочка, тарифы, число тестов),
   README (голоса, тарифы), `.env.example` / `deploy/.env.example` / `docker-compose.yml`.
8. Проверка: `pnpm build && pnpm test && pnpm lint && pnpm format:check`, предложить одну строку коммита.

### Открытые вопросы к владельцу

- Сколько пробных роастов хорошим голосом на Free (сейчас 2)?
- Потолок Яндекса после квоты: подтвердить Basic +200 / Premium +500.
- Цена ⭐: подтвердить 300 / 600.
- Чем озвучивать «хорошие» роасты, пока жив ElevenLabs: им (как решено в п. 1) или сразу Inworld,
  чтобы голос не менялся посреди месяца у всех каналов разом? Владелец решил «пусть догорит».
- Список голосов Inworld (ID и названия) и голоса Мицуки/Аи на Inworld.
- Можно ли тарифу выбрать Inworld как голос «потом» (economy)?
