// Overview: what needs attention, money against the limits, today.
import { Link, Metric, State } from "../ui.js";
import { Section, useAdmin } from "./common.js";
import type { Overview } from "./types.js";

const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const share = (used: number, limit: number) => used / Math.max(limit, 0.000_001);

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
            note={`символов из ${data.elevenLabsLimit.toLocaleString("ru-RU")}, дальше Яндекс. ${
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
            label="Яндекс SpeechKit"
            value={`${data.yandexTtsSpentRub.toFixed(0)} ₽`}
            note={`из ${String(data.yandexTtsLimitRub)} ₽, дальше Piper`}
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
            note={`из ${String(data.demoLimit)} в день · $${data.demoSpentMonth.toFixed(2)} за месяц`}
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
    </>
  );
}
