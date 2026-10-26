// Best roasts and viewers who opted out. The streamer stars a roast (that is the consent to show
// it); the owner approves it for the landing page, where it appears without the viewer's name.
// Viewers opt out themselves with "!роаст-стоп"; the streamer sees the list and may clear it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { denied, session, type RouteContext } from "./context.js";

const idParams = z.object({ id: z.string().uuid() });

export function registerShowcaseRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, requireUser, requireOwner, audit } = context;

  app.post("/roasts/:id/favorite", { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { favorite } = z.object({ favorite: z.boolean() }).parse(request.body);
    // Taking the star back also takes the roast off the landing page.
    const [row] = await sql<{ favoriteAt: Date | null }[]>`
      update roasts set favorite_at=${favorite ? new Date() : null},
        showcase_approved_at=case when ${favorite} then showcase_approved_at end
      where id=${id} and channel_id=${session(request).channelId} and status='done'
      returning favorite_at "favoriteAt"`;
    if (!row) return denied(reply, 404, "not_found", "Отметить можно только прозвучавший роаст");
    return { id, favorite: row.favoriteAt !== null };
  });

  app.get(
    "/showcase",
    async () =>
      sql`select r.id, r.output_text "text", r.tone, c.twitch_login "channel"
      from roasts r join channels c on c.id=r.channel_id
      where r.showcase_approved_at is not null and r.favorite_at is not null
        and r.output_text is not null
      order by r.showcase_approved_at desc limit 6`
  );

  app.get(
    "/admin/showcase",
    { preHandler: requireOwner },
    async () =>
      sql`select r.id, r.output_text "text", r.input_text "inputText", r.tone,
        c.twitch_login "channel", r.favorite_at "favoriteAt",
        r.showcase_approved_at "approvedAt"
      from roasts r join channels c on c.id=r.channel_id
      where r.favorite_at is not null and r.output_text is not null
      order by r.showcase_approved_at is not null, r.favorite_at desc limit 100`
  );

  app.post("/admin/roasts/:id/showcase", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { approved } = z.object({ approved: z.boolean() }).parse(request.body);
    const updated = await sql.begin(async (tx) => {
      const rows = await tx`update roasts set showcase_approved_at=${approved ? new Date() : null}
        where id=${id} and favorite_at is not null returning id`;
      if (rows.length) await audit(tx, request, "showcase.review", id, { approved });
      return rows.length > 0;
    });
    if (!updated) return denied(reply, 404, "not_found", "Стример не отмечал этот роаст");
    return { id, approved };
  });

  app.get(
    "/optouts",
    { preHandler: requireUser },
    async (request) =>
      sql`select viewer_login "viewerLogin", created_at "createdAt" from viewer_optouts
      where channel_id=${session(request).channelId} order by created_at desc limit 500`
  );

  app.delete("/optouts/:login", { preHandler: requireUser }, async (request) => {
    const { login } = z.object({ login: z.string().min(1).max(64) }).parse(request.params);
    await sql`delete from viewer_optouts
      where channel_id=${session(request).channelId} and viewer_login=${login}`;
    return { login, removed: true };
  });
}
