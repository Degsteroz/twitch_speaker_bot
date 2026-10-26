// Premium characters and their shop. A premium channel builds up to MAX_OWN_CHARACTERS heroines
// (name, archetype, ElevenLabs voice, picture) and uses its own right away on its own stream. To
// reach other channels the author offers one to the shop; the owner approves it, since the picture
// would appear on someone else's stream. A published character is locked: the author may take it
// back or delete it, not swap the picture under the channels that chose it.
//
// Pictures are re-encoded to WebP here (EXIF and anything else in the file is dropped) and kept in
// the database with the voice samples: they are few and small, and pg_dump backs them up.
import { createHash } from "node:crypto";

import { findStopListMatch } from "@roastbot/prompts";
import {
  CUSTOM_CHARACTER_PLANS,
  MAX_CHARACTER_IMAGE_BYTES,
  MAX_CHARACTER_UPLOAD_BYTES,
  MAX_OWN_CHARACTERS,
  VOICE_SAMPLE_QUEUE,
  characterInputSchema,
  elevenLabsVoiceIdSchema,
  selectCharacterSchema
} from "@roastbot/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PendingQuery, Row } from "postgres";
import sharp from "sharp";
import { z } from "zod";

import { denied, session, type RouteContext, type Sql } from "./context.js";

const idParams = z.object({ id: z.string().uuid() });
const voiceParams = z.object({ id: elevenLabsVoiceIdSchema });
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
// The overlay shows the picture up to 640 px high next to the card; built-in ones are 464×1150.
const IMAGE_BOX = { width: 520, height: 1280 };

export interface CharacterRow {
  id: string;
  name: string;
  archetype: string;
  voiceId: string | null;
  voiceLabel: string | null;
  status: string;
  reviewNote: string | null;
  imageHash: string | null;
  author: string;
  own: boolean;
}

/** The path the panel and the overlay load the picture from; the hash busts caches on change. */
export const characterImagePath = (id: string, hash: string) =>
  `/characters/${id}/image?v=${hash.slice(0, 16)}`;

const characterView = ({ imageHash, ...row }: CharacterRow) => ({
  ...row,
  imagePath: imageHash ? characterImagePath(row.id, imageHash) : null
});

/** Any picture in, a WebP portrait of at most MAX_CHARACTER_IMAGE_BYTES out, or null. */
export async function normalizeCharacterImage(input: Buffer): Promise<Buffer | null> {
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000 });
    const { format } = await image.metadata();
    if (!format || !["png", "jpeg", "webp"].includes(format)) return null;
    const resized = image
      .rotate()
      .resize({ ...IMAGE_BOX, fit: "inside", withoutEnlargement: true });
    for (const quality of [85, 70, 55]) {
      const output = await resized.clone().webp({ quality, alphaQuality: 90 }).toBuffer();
      if (output.length <= MAX_CHARACTER_IMAGE_BYTES) return output;
    }
    return null;
  } catch {
    return null;
  }
}

async function planAllowsCharacters(sql: Sql, channelId: string): Promise<boolean> {
  const [row] = await sql<{ plan: string | null }[]>`
    select p.code plan from channels c
    left join lateral (
      select plan_id from subscriptions sub where sub.user_id=c.user_id
      and (sub.valid_until is null or sub.valid_until>now()) order by sub.created_at desc limit 1
    ) sub on true
    left join plans p on p.id=sub.plan_id
    where c.id=${channelId}`;
  return CUSTOM_CHARACTER_PLANS.has(row?.plan ?? "");
}

/** The built-in stop list and the service-wide words; a name is said aloud on stream. */
async function nameProblem(sql: Sql, name: string): Promise<string | null> {
  const [row] = await sql<{ words: string[] | null }[]>`
    select value "words" from global_settings where key='global_stop_words'`;
  return findStopListMatch(name, row?.words ?? []) ? "Это имя нельзя использовать" : null;
}

export function registerCharacterRoutes(app: FastifyInstance, context: RouteContext) {
  const { sql, boss, requireUser, requireOwner, audit } = context;

  const requirePremium = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await planAllowsCharacters(sql, session(request).channelId))) {
      return denied(reply, 403, "plan_required", "Своя героиня доступна на тарифе Premium");
    }
  };

  // Pictures arrive as the raw request body; the route re-encodes them.
  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: "buffer", bodyLimit: MAX_CHARACTER_UPLOAD_BYTES },
    (_request, body, done) => done(null, body)
  );

  const selectCharacters = (where: PendingQuery<Row[]>, channelId: string) =>
    sql<CharacterRow[]>`
      select ch.id, ch.name, ch.archetype, ch.voice_id "voiceId", v.label "voiceLabel",
        ch.status, ch.review_note "reviewNote", ch.image_hash "imageHash",
        c.twitch_login "author", ch.author_channel_id=${channelId} "own"
      from characters ch join channels c on c.id=ch.author_channel_id
      left join voices v on v.id=ch.voice_id
      where ${where}`;

  const ownCharacter = async (id: string, channelId: string) => {
    const [row] = await sql<{ status: string; hasImage: boolean }[]>`
      select status, image is not null "hasImage" from characters
      where id=${id} and author_channel_id=${channelId}`;
    return row;
  };

  // The voice is the point of an own character: once the owner offers voices, one is required.
  const voiceProblem = async (voiceId: string | null) => {
    if (voiceId === null) {
      const [offered] = await sql`select 1 from voices where enabled limit 1`;
      return offered ? "Выбери голос" : null;
    }
    const [voice] = await sql`select 1 from voices where id=${voiceId} and enabled`;
    return voice ? null : "Этот голос недоступен";
  };

  // ---- the streamer ------------------------------------------------------------------------
  app.get("/characters", { preHandler: requireUser }, async (request) => {
    const { channelId } = session(request);
    const [allowed, own, shop, voices, [selected]] = await Promise.all([
      planAllowsCharacters(sql, channelId),
      selectCharacters(sql`ch.author_channel_id=${channelId} order by ch.created_at`, channelId),
      selectCharacters(
        sql`ch.status='published' and ch.author_channel_id<>${channelId}
          order by ch.published_at desc limit 100`,
        channelId
      ),
      sql<{ id: string; label: string; description: string; sampleReady: boolean }[]>`
        select id, label, description, sample_status='ready' "sampleReady" from voices
        where enabled order by sort, label`,
      sql<{ characterId: string | null; characterName: string | null }[]>`
        select character_id "characterId", character_name "characterName" from settings
        where channel_id=${channelId}`
    ]);
    return {
      allowed,
      maxOwn: MAX_OWN_CHARACTERS,
      selected: selected ?? { characterId: null, characterName: null },
      own: own.map(characterView),
      shop: shop.map(characterView),
      voices
    };
  });

  app.post("/characters", { preHandler: [requireUser, requirePremium] }, async (request, reply) => {
    const { channelId } = session(request);
    const input = characterInputSchema.parse(request.body);
    const problem = (await nameProblem(sql, input.name)) ?? (await voiceProblem(input.voiceId));
    if (problem) return denied(reply, 400, "invalid_character", problem);
    // The count and the insert under one lock: two quick clicks cannot make a fourth character.
    const created = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`characters:${channelId}`}))`;
      const [owned] = await tx<{ count: number }[]>`
          select count(*)::int count from characters where author_channel_id=${channelId}`;
      if ((owned?.count ?? 0) >= MAX_OWN_CHARACTERS) return null;
      const [row] = await tx<{ id: string }[]>`
          insert into characters(author_channel_id,name,archetype,voice_id)
          values(${channelId},${input.name},${input.archetype},${input.voiceId}) returning id`;
      return row!;
    });
    if (!created) {
      return denied(
        reply,
        409,
        "character_limit",
        `Можно создать не больше ${String(MAX_OWN_CHARACTERS)} героинь`
      );
    }
    return reply.code(201).send(created);
  });

  app.patch("/characters/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { channelId } = session(request);
    const input = characterInputSchema.parse(request.body);
    const current = await ownCharacter(id, channelId);
    if (!current) return denied(reply, 404, "not_found", "Героиня не найдена");
    if (current.status === "published") {
      return denied(reply, 409, "character_published", "Сначала снимите героиню с публикации");
    }
    const problem = (await nameProblem(sql, input.name)) ?? (await voiceProblem(input.voiceId));
    if (problem) return denied(reply, 400, "invalid_character", problem);
    // An edit withdraws a pending offer: the owner reviews what will actually be shown.
    await sql`update characters set name=${input.name}, archetype=${input.archetype},
      voice_id=${input.voiceId}, status='private', updated_at=now()
      where id=${id} and author_channel_id=${channelId}`;
    return { id };
  });

  app.put(
    "/characters/:id/image",
    { preHandler: requireUser, bodyLimit: MAX_CHARACTER_UPLOAD_BYTES },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { channelId } = session(request);
      const current = await ownCharacter(id, channelId);
      if (!current) return denied(reply, 404, "not_found", "Героиня не найдена");
      if (current.status === "published") {
        return denied(reply, 409, "character_published", "Сначала снимите героиню с публикации");
      }
      if (!Buffer.isBuffer(request.body)) {
        return denied(reply, 415, "invalid_image", "Загрузите PNG, JPEG или WebP");
      }
      const image = await normalizeCharacterImage(request.body);
      if (!image) {
        return denied(
          reply,
          400,
          "invalid_image",
          "Не удалось прочитать картинку или она слишком большая"
        );
      }
      const hash = createHash("sha256").update(image).digest("hex");
      await sql`update characters set image=${image}, image_hash=${hash}, status='private',
        updated_at=now() where id=${id} and author_channel_id=${channelId}`;
      return { id, imagePath: characterImagePath(id, hash) };
    }
  );

  app.post("/characters/:id/publish", { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { channelId } = session(request);
    const current = await ownCharacter(id, channelId);
    if (!current) return denied(reply, 404, "not_found", "Героиня не найдена");
    if (!current.hasImage)
      return denied(reply, 409, "image_required", "Сначала загрузите картинку");
    if (current.status === "published" || current.status === "pending")
      return { id, status: current.status };
    await sql`update characters set status='pending', review_note=null, updated_at=now()
      where id=${id} and author_channel_id=${channelId}`;
    return { id, status: "pending" };
  });

  // Takes the character out of the shop (or back from review). Channels that picked her fall back
  // to their built-in character; the author keeps using her.
  app.post("/characters/:id/unpublish", { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [row] = await sql`update characters set status='private', published_at=null,
      updated_at=now() where id=${id} and author_channel_id=${session(request).channelId}
      returning id`;
    if (!row) return denied(reply, 404, "not_found", "Героиня не найдена");
    return { id, status: "private" };
  });

  app.delete("/characters/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [row] = await sql`delete from characters
      where id=${id} and author_channel_id=${session(request).channelId} returning id`;
    if (!row) return denied(reply, 404, "not_found", "Героиня не найдена");
    return { id, deleted: true };
  });

  // The channel's choice. Clearing it works on any plan; choosing needs Premium and a character
  // this channel may use: its own, or a published one, with a picture.
  app.put("/settings/character", { preHandler: requireUser }, async (request, reply) => {
    const { channelId } = session(request);
    const { characterId, characterName } = selectCharacterSchema.parse(request.body);
    if (characterId !== null) {
      if (!(await planAllowsCharacters(sql, channelId))) {
        return denied(reply, 403, "plan_required", "Своя героиня доступна на тарифе Premium");
      }
      const [usable] = await sql`select 1 from characters where id=${characterId}
        and image is not null and (author_channel_id=${channelId} or status='published')`;
      if (!usable) return denied(reply, 404, "not_found", "Эта героиня недоступна");
      const problem = characterName && (await nameProblem(sql, characterName));
      if (problem) return denied(reply, 400, "invalid_character", problem);
    }
    await sql`update settings set character_id=${characterId},
      character_name=${characterId === null ? null : characterName}, updated_at=now()
      where channel_id=${channelId}`;
    return { characterId, characterName: characterId === null ? null : characterName };
  });

  // Public: the overlay loads it without a session. The id is random and the URL is versioned.
  app.get("/characters/:id/image", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [row] = await sql<
      { image: Buffer | null }[]
    >`select image from characters where id=${id}`;
    if (!row?.image) return denied(reply, 404, "not_found", "Картинки нет");
    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .type("image/webp")
      .send(row.image);
  });

  app.get("/voices/:id/sample", async (request, reply) => {
    const { id } = voiceParams.parse(request.params);
    const [row] = await sql<{ sample: Buffer | null }[]>`
      select sample from voices where id=${id} and enabled and sample_status='ready'`;
    if (!row?.sample) return denied(reply, 404, "not_found", "Сэмпла нет");
    return reply
      .header("Cache-Control", "public, max-age=3600")
      .header("X-Content-Type-Options", "nosniff")
      .type("audio/wav")
      .send(row.sample);
  });

  // ---- the owner ---------------------------------------------------------------------------
  app.get("/admin/characters", { preHandler: requireOwner }, async () => {
    const rows = await sql<(CharacterRow & { usedBy: number })[]>`
      select ch.id, ch.name, ch.archetype, ch.voice_id "voiceId", v.label "voiceLabel",
        ch.status, ch.review_note "reviewNote", ch.image_hash "imageHash",
        c.twitch_login "author", false "own",
        (select count(*)::int from settings s where s.character_id=ch.id) "usedBy"
      from characters ch join channels c on c.id=ch.author_channel_id
      left join voices v on v.id=ch.voice_id
      where ch.status in ('pending','published')
      order by ch.status='pending' desc, ch.updated_at desc limit 200`;
    return rows.map((row) => ({ ...characterView(row), usedBy: row.usedBy }));
  });

  app.post("/admin/characters/:id/review", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { approve, note } = z
      .object({ approve: z.boolean(), note: z.string().trim().max(300).optional() })
      .parse(request.body);
    const updated = await sql.begin(async (tx) => {
      const rows = approve
        ? await tx`update characters set status='published', published_at=now(),
              review_note=null, updated_at=now()
              where id=${id} and status='pending' and image is not null returning id`
        : await tx`update characters set status='rejected', published_at=null,
              review_note=${note ?? null}, updated_at=now()
              where id=${id} and status in ('pending','published') returning id`;
      if (rows.length)
        await audit(tx, request, "character.review", id, { approve, note: note ?? null });
      return rows.length > 0;
    });
    if (!updated) return denied(reply, 404, "not_found", "Нечего проверять");
    return { id, status: approve ? "published" : "rejected" };
  });

  app.get(
    "/admin/voices",
    { preHandler: requireOwner },
    async () =>
      sql`select v.id, v.label, v.description, v.enabled, v.sort, v.sample_status "sampleStatus",
        (select count(*)::int from characters ch where ch.voice_id=v.id) "usedBy"
      from voices v order by v.sort, v.label`
  );

  const queueSample = (voiceId: string) =>
    boss.send(VOICE_SAMPLE_QUEUE, { voiceId }, { singletonKey: voiceId });

  const voiceInput = z
    .object({
      label: z.string().trim().min(1).max(40),
      description: z.string().trim().max(200).default(""),
      sort: z.number().int().min(0).max(1_000).default(0),
      enabled: z.boolean().default(true)
    })
    .strict();

  app.post("/admin/voices", { preHandler: requireOwner }, async (request, reply) => {
    const { id, ...input } = voiceInput.extend({ id: elevenLabsVoiceIdSchema }).parse(request.body);
    const added = await sql.begin(async (tx) => {
      const rows = await tx`insert into voices(id,label,description,sort,enabled)
        values(${id},${input.label},${input.description},${input.sort},${input.enabled})
        on conflict(id) do nothing returning id`;
      if (rows.length) await audit(tx, request, "voice.add", id, { label: input.label });
      return rows.length > 0;
    });
    if (!added) return denied(reply, 409, "voice_exists", "Такой голос уже добавлен");
    await queueSample(id);
    return reply.code(201).send({ id, sampleStatus: "pending" });
  });

  app.patch("/admin/voices/:id", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = voiceParams.parse(request.params);
    const input = voiceInput.partial().parse(request.body);
    const updated = await sql.begin(async (tx) => {
      const rows = await tx`update voices set label=coalesce(${input.label ?? null},label),
        description=coalesce(${input.description ?? null},description),
        sort=coalesce(${input.sort ?? null}::int,sort),
        enabled=coalesce(${input.enabled ?? null}::boolean,enabled)
        where id=${id} returning id`;
      if (rows.length) await audit(tx, request, "voice.update", id, input);
      return rows.length > 0;
    });
    if (!updated) return denied(reply, 404, "not_found", "Голос не найден");
    return { id };
  });

  app.post("/admin/voices/:id/sample", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = voiceParams.parse(request.params);
    const [row] = await sql`update voices set sample_status='pending' where id=${id} returning id`;
    if (!row) return denied(reply, 404, "not_found", "Голос не найден");
    await queueSample(id);
    return { id, sampleStatus: "pending" };
  });

  // Characters with this voice keep working: they speak with their archetype's Yandex voice.
  app.delete("/admin/voices/:id", { preHandler: requireOwner }, async (request, reply) => {
    const { id } = voiceParams.parse(request.params);
    const deleted = await sql.begin(async (tx) => {
      const rows = await tx`delete from voices where id=${id} returning id`;
      if (rows.length) await audit(tx, request, "voice.delete", id, {});
      return rows.length > 0;
    });
    if (!deleted) return denied(reply, 404, "not_found", "Голос не найден");
    return { id, deleted: true };
  });
}
