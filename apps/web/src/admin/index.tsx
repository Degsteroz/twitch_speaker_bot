// The owner's back-office: /admin/<tab>. Every tab answers one question — what needs me now,
// who uses the service, what the bot said, what is blocked, how it is tuned, who changed what.
// One file per tab.
import type { Session } from "../api.js";
import { ADMIN_TABS, type AdminTab } from "../routes.js";
import { Link, Shell } from "../ui.js";
import { Audit } from "./audit.js";
import { Moderation } from "./moderation.js";
import { AdminOverview } from "./overview.js";
import { Payments } from "./payments.js";
import { AdminRoasts } from "./roasts.js";
import { AdminSettings } from "./settings.js";
import { AdminUsers } from "./users.js";

export function Admin({ session, tab }: { session: Session; tab: AdminTab }) {
  return (
    <Shell session={session} admin>
      <div className="page-title">
        <div>
          <p className="eyebrow">АДМИНКА</p>
          <h1>Центр управления</h1>
          <p>Что требует внимания, кто пользуется сервисом и как он настроен.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Разделы админки">
        {ADMIN_TABS.map(([id, label]) => (
          <Link key={id} className={tab === id ? "active" : ""} href={`/admin/${id}`}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <AdminOverview />}
      {tab === "users" && <AdminUsers selfId={session.userId} />}
      {tab === "roasts" && <AdminRoasts />}
      {tab === "moderation" && <Moderation />}
      {tab === "payments" && <Payments />}
      {tab === "settings" && <AdminSettings />}
      {tab === "audit" && <Audit />}
    </Shell>
  );
}
