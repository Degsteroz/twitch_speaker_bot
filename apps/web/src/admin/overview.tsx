// Overview: what needs attention, money against the limits, today.
import { Link, Metric, State } from "../ui.js";
import { Section, useAdmin } from "./common.js";
import type { Overview, ServerHealth } from "./types.js";

const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const share = (used: number, limit: number) => used / Math.max(limit, 0.000_001);

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ`
    : `${Math.round(bytes / 1024 ** 2).toLocaleString("ru-RU")} МБ`;

/**
 * The VPS as the API container sees it: load and memory of the host, the disk the volumes live
 * on, the database and the audio folder. Read when the tab opens, never in the background.
 */
function ServerSection() {
  const { data, error, load } = useAdmin<ServerHealth>("/admin/server");
  if (error) return <State title="Сервер не ответил" text={error} action={load} />;
  if (!data) return null;
  const [load1 = 0, , load15 = 0] = data.load;
  const memoryUsed = data.memory.total - data.memory.free;
  const diskUsed = data.disk ? data.disk.total - data.disk.free : 0;
  return (
    <Section
      title="Сервер"
      note={`Работает ${String(Math.floor(data.uptimeSec / 86_400))} дн. Нагрузка выше числа ядер или почти полный диск — причина тормозов.`}
    >
      <div className="metric-grid">
        <Metric
          label="Нагрузка"
          value={load1.toFixed(2)}
          note={`за минуту · ${load15.toFixed(2)} за 15 минут · ядер ${String(data.cpus)}`}
          used={share(load1, data.cpus)}
          warn={load15 > data.cpus}
        />
        <Metric
          label="Память"
          value={size(memoryUsed)}
          note={`занято из ${size(data.memory.total)}, свободно ${size(data.memory.free)}`}
          used={share(memoryUsed, data.memory.total)}
          warn={share(memoryUsed, data.memory.total) > 0.9}
        />
        {data.disk && (
          <Metric
            label="Диск"
            value={size(data.disk.free)}
            note={`свободно из ${size(data.disk.total)}`}
            used={share(diskUsed, data.disk.total)}
            warn={share(diskUsed, data.disk.total) > 0.85}
          />
        )}
        <Metric
          label="База данных"
          value={size(data.database)}
          note={data.tables
            .slice(0, 3)
            .map((table) => `${table.name} ${size(table.bytes)}`)
            .join(" · ")}
        />
        {data.audio && (
          <Metric
            label="Аудио"
            value={size(data.audio.bytes)}
            note={`${String(data.audio.files)} файлов, старые чистятся сами`}
          />
        )}
      </div>
      <button className="button secondary" onClick={() => void load()}>
        Обновить
      </button>
    </Section>
  );
}

export function AdminOverview() {
  const { data, error, load } = useAdmin<Overview>("/admin/overview");
  if (error) return <State title="Обзор недоступен" text={error} action={load} />;
  if (!data) return <State title="Считаем метрики…" busy />;
  const errorRate =
    data.roastsToday + data.errorsToday
      ? (data.errorsToday / (data.roastsToday + data.errorsToday)) * 100
      : 0;
  return (
    <>
      {data.killSwitch && (
        <div className="reauth" role="alert">
          <span>
            <strong>Kill switch включён:</strong> бот молчит на всех каналах.
          </span>
          <Link className="button secondary" href="/admin/settings">
            Настройки
          </Link>
        </div>
      )}
      <Section title="Требует внимания" note="Карточки ведут туда, где это разбирается.">
        <div className="metric-grid">
          <Metric
            label="Заявки"
            value={data.usersPending}
            note={data.usersPending ? "ждут одобрения" : "новых нет"}
            warn={data.usersPending > 0}
            href="/admin/users"
          />
          <Metric
            label="Модерация"
            value={data.pendingModeration}
            note={data.pendingModeration ? "блоки ждут проверки" : "очередь пуста"}
            warn={data.pendingModeration > 0}
            href="/admin/moderation"
          />
          <Metric
            label="Ошибки сегодня"
            value={data.errorsToday}
            note={`${errorRate.toFixed(1)}% роастов, цель меньше 2%`}
            warn={errorRate >= 2}
            href="/admin/roasts?status=failed"
          />
        </div>
      </Section>
      <Section
        title="Деньги за месяц"
        note="После лимита Anthropic бот молчит, голоса переходят на следующий."
      >
        <div className="metric-grid">
          <Metric
            label="Anthropic"
            value={`$${data.spentMonth.toFixed(2)}`}
            note={`из $${data.budget.toFixed(2)} бюджета`}
            used={share(data.spentMonth, data.budget)}
            warn={share(data.spentMonth, data.budget) > 0.8}
          />
          <Metric
            label="ElevenLabs"
            value={data.elevenLabsChars.toLocaleString("ru-RU")}
            note={`символов из ${data.elevenLabsLimit.toLocaleString("ru-RU")}, дальше Inworld. ${
              data.elevenLabsSyncedAt
                ? `Сверено с ElevenLabs в ${shortTime(data.elevenLabsSyncedAt)}${
                    data.elevenLabsResetAt
                      ? `, сброс ${new Date(data.elevenLabsResetAt).toLocaleDateString("ru-RU")}`
                      : ""
                  }`
                : "С ElevenLabs не сверено: счёт приложения"
            }`}
            used={share(data.elevenLabsChars, data.elevenLabsLimit)}
            warn={share(data.elevenLabsChars, data.elevenLabsLimit) > 0.8}
          />
          <Metric
            label="Inworld"
            value={data.inworldChars.toLocaleString("ru-RU")}
            note={`символов из ${data.inworldLimit.toLocaleString("ru-RU")}, дальше Яндекс`}
            used={share(data.inworldChars, data.inworldLimit)}
            warn={share(data.inworldChars, data.inworldLimit) > 0.8}
          />
          <Metric
            label="Яндекс SpeechKit"
            value={`${data.yandexTtsSpentRub.toFixed(0)} ₽`}
            note={`из ${String(data.yandexTtsLimitRub)} ₽, дальше аварийный Piper`}
            used={share(data.yandexTtsSpentRub, data.yandexTtsLimitRub)}
            warn={share(data.yandexTtsSpentRub, data.yandexTtsLimitRub) > 0.8}
          />
          <Metric
            label="Роасты"
            value={data.roastsMonth}
            note={`из ${String(data.roastCap)} на весь сервис`}
            used={share(data.roastsMonth, data.roastCap)}
            warn={share(data.roastsMonth, data.roastCap) > 0.8}
          />
        </div>
      </Section>
      <Section title="Сегодня">
        <div className="metric-grid">
          <Metric
            label="Роасты"
            value={data.roastsToday}
            note={`${String(data.blockedToday)} заблокировано · ${String(data.skippedToday)} пропущено`}
            href="/admin/roasts"
          />
          <Metric
            label="Каналы за час"
            value={data.activeChannelsHour}
            note="получили хотя бы один роаст"
          />
          <Metric
            label="Демо на лендинге"
            value={data.demoToday}
            note={`из ${String(data.demoLimit)} в день · $${data.demoSpentMonth.toFixed(2)} за месяц · ElevenLabs ${data.demoElevenLabsChars.toLocaleString("ru-RU")} из ${data.demoElevenLabsLimit.toLocaleString("ru-RU")} символов`}
            used={share(data.demoToday, data.demoLimit)}
          />
          <Metric
            label="Пользователи"
            value={data.usersActive}
            note={`активных из ${String(data.usersTotal)}`}
            href="/admin/users"
          />
        </div>
      </Section>
      <ServerSection />
    </>
  );
}
