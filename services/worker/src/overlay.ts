// The overlay outbox: the audio file the API signs on delivery, and the queued event itself.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ARCHETYPE_THEME,
  BRANDED_PLANS,
  type Archetype,
  type RoastRequestedJob,
  type StoredOverlayRoast,
  type StubSound
} from "@roastbot/shared";

import type { OnAirCharacter, Sql } from "./context.js";

export async function storeAudio(bytes: Uint8Array, audioDir: string): Promise<string> {
  const filename = `${randomUUID()}.wav`;
  await mkdir(audioDir, { recursive: true });
  const temporary = join(audioDir, `.${randomBytes(12).toString("hex")}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, join(audioDir, filename));
  return filename;
}

/** Queues a spoken reply for the channel's overlay and wakes the API's dispatcher. */
export async function publishOverlay(
  tx: Sql,
  input: {
    job: RoastRequestedJob;
    roastId: string;
    text: string;
    archetype: Archetype;
    character: OnAirCharacter | undefined;
    planCode: string | null;
    /** A spoken reply; a free stub has none and plays `sound` instead. */
    audioFile?: string;
    sound?: StubSound;
    now: Date;
    expiresAt: Date;
  }
) {
  const { job, character } = input;
  const overlayId = randomUUID();
  const payload: StoredOverlayRoast = {
    version: 1,
    type: "roast.play",
    eventId: overlayId,
    roastId: input.roastId,
    viewerLogin: job.viewerLogin,
    text: input.text,
    tone: ARCHETYPE_THEME[input.archetype],
    ...(character ? { character: { name: character.name, imagePath: character.imagePath } } : {}),
    ...(BRANDED_PLANS.has(input.planCode ?? "") ? { branding: true } : {}),
    ...(input.audioFile ? { audioFile: input.audioFile } : {}),
    ...(input.sound ? { sound: input.sound } : {}),
    expiresAt: input.expiresAt.toISOString(),
    sentAt: input.now.toISOString()
  };
  await tx`insert into overlay_events(id,channel_id,roast_id,payload,expires_at)
    values(${overlayId},${job.channelId},${input.roastId},${tx.json(payload)},${input.expiresAt.toISOString()})`;
  await tx`select pg_notify('overlay_events',${job.channelId})`;
}
