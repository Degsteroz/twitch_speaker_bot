// Invite links: roast.recursia.online/i/<code>. A link lets a new streamer in without the review
// queue and may grant a plan for some days (the free Premium for promo streamers). Each account
// uses a link once; the owner sets how many accounts may use it and until when.
import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";

import { denied, session, type RouteContext } from "./context.js";

export const inviteCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);

/**
 * Applies a link at sign-in, inside the login transaction. A pending account becomes active; a
 * plan link adds a subscription for its days. Suspended accounts stay suspended. Returns whether
 * the link was used.
 */
export async function applyInviteLink(
  tx: TransactionSql,
  code: string,
  user: { id: string; status: string }
): Promise<boolean> {
  const [link] = await tx<{ plan: string | null; planDays: number | null }[]>`
    update invite_links set uses=uses+1
    where code=${code} and revoked_at is null and (expires_at is null or expires_at>now())
      and uses<max_uses
      and not exists (select 1 from invite_link_uses where code=${code} and user_id=${user.id})
    returning plan, plan_days "planDays"`;
  if (!link) return false;
  await tx`insert into invite_link_uses(code,user_id) values(${code},${user.id})`;
  if (user.status === "pending") {
    await tx`update users set status='active' where id=${user.id}`;
    user.status = "active";
  }
  if (link.plan && link.planDays) {
    // clock_timestamp, not now(): the free plan was added in this transaction, and the newest
    // subscription is the one that counts.
    await tx`insert into subscriptions(user_id,plan_id,valid_until,source,created_at)
      select ${user.id}, id, now()+${link.planDays}*interval '1 day', 'invite', clock_timestamp()
      from plans where code=${link.plan}`;
  }
  await tx`insert into audit_log(actor_user_id,action,target,payload)
    values(${user.id},'invite_link.use',${code},${tx.json({ plan: link.plan, planDays: link.planDays })})`;
  return true;
}

const linkSchema = z
  .object({
    note: z.string().trim().max(200).optional(),
    plan: z.enum(["basic", "premium"]).nullable().default(null),
    planDays: z.number().int().min(1).max(365).nullable().default(null),
    maxUses: z.number().int().min(1).max(1_000).default(1),
    expiresInDays: z.number().int().min(1).max(365).nullable().default(null)
  })
  .strict()
  .refine((value) => (value.plan === null) === (value.planDays === null), {
    message: "Тариф и срок задаются вместе"
  });

export function registerInviteRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, requireOwner, audit } = context;

  // Public: the invite page shows what the link gives before the Twitch login.
  app.get("/invite-links/:code", async (request, reply) => {
    const parsed = inviteCodeSchema.safeParse((request.params as { code?: string }).code);
    if (!parsed.success) return denied(reply, 404, "not_found", "Ссылка не найдена");
    const [link] = await sql<{ plan: string | null; planDays: number | null; usable: boolean }[]>`
      select plan, plan_days "planDays",
        (revoked_at is null and (expires_at is null or expires_at>now()) and uses<max_uses) usable
      from invite_links where code=${parsed.data}`;
    if (!link?.usable)
      return denied(reply, 404, "not_found", "Ссылка недействительна или уже использована");
    return { plan: link.plan, planDays: link.planDays };
  });

  app.get(
    "/admin/invite-links",
    { preHandler: requireOwner },
    async () =>
      sql`select l.code, l.note, l.plan, l.plan_days "planDays", l.max_uses "maxUses", l.uses,
        l.expires_at "expiresAt", l.revoked_at "revokedAt", l.created_at "createdAt",
        coalesce((select array_agg(u.login order by iu.used_at) from invite_link_uses iu
          join users u on u.id=iu.user_id where iu.code=l.code), '{}') "usedBy"
      from invite_links l order by l.revoked_at is not null, l.created_at desc limit 200`
  );

  app.post("/admin/invite-links", { preHandler: requireOwner }, async (request) => {
    const body = linkSchema.parse(request.body ?? {});
    const code = randomBytes(9).toString("base64url");
    await sql.begin(async (tx) => {
      await tx`insert into invite_links(code,note,plan,plan_days,max_uses,expires_at,created_by_user_id)
        values(${code},${body.note || null},${body.plan},${body.planDays},${body.maxUses},
          ${body.expiresInDays === null ? null : new Date(Date.now() + body.expiresInDays * 86_400_000)},
          ${session(request).userId})`;
      await audit(tx, request, "invite_link.create", code, body);
    });
    return { code, ...body };
  });

  app.post(
    "/admin/invite-links/:code/revoke",
    { preHandler: requireOwner },
    async (request, reply) => {
      const code = inviteCodeSchema.parse((request.params as { code?: string }).code);
      const revoked = await sql.begin(async (tx) => {
        const rows = await tx`update invite_links set revoked_at=now()
        where code=${code} and revoked_at is null returning code`;
        if (rows.length) await audit(tx, request, "invite_link.revoke", code, {});
        return rows.length > 0;
      });
      if (!revoked) return denied(reply, 404, "not_found", "Ссылка не найдена");
      return { code, revoked: true };
    }
  );
}
