// Overlay delivery: the OBS page's WebSocket, the outbox it drains and the signed audio files.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { WebSocket } from "@fastify/websocket";
import { overlayClientEventSchema, storedOverlayRoastSchema } from "@roastbot/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { RouteContext } from "./context.js";
import { signAudioPath, verifyAudioSignature } from "./security.js";

interface OverlayConnection {
  socket: WebSocket;
  channelId: string;
  sent: Set<string>;
}

export interface Overlays {
  /** Closes every open overlay of the channel, e.g. after its token was rotated. */
  close(channelId: string, reason: string): void;
  /** The overlay page is open somewhere (OBS) for this channel. */
  connected(channelId: string): boolean;
  shutdown(): Promise<void>;
}

export async function registerOverlayRoutes(
  app: FastifyInstance,
  context: Pick<RouteContext, "sql" | "config">
): Promise<Overlays> {
  const { sql, config } = context;
  // By channel: a notification wakes only that channel's sockets, however many are open.
  const connections = new Map<string, Set<OverlayConnection>>();

  const sendJson = (socket: WebSocket, value: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  };

  const deliverPending = async (connection: OverlayConnection) => {
    const rows = await sql<{ id: string; payload: unknown }[]>`
      select id, payload from overlay_events where channel_id=${connection.channelId}
      and status='pending' and available_at <= now() and expires_at > now() order by created_at`;
    for (const row of rows) {
      if (connection.sent.has(row.id)) continue;
      const stored = storedOverlayRoastSchema.safeParse(row.payload);
      if (!stored.success) continue;
      const { audioFile, character, ...event } = stored.data;
      connection.sent.add(row.id);
      sendJson(connection.socket, {
        ...event,
        ...(character
          ? {
              character: {
                name: character.name,
                imageUrl: `${config.PUBLIC_URL}${character.imagePath}`
              }
            }
          : {}),
        // A free stub has no audio file: the overlay plays its `sound` instead.
        ...(audioFile
          ? {
              audioUrl: `${config.PUBLIC_URL}${signAudioPath(audioFile, config.AUDIO_SIGNING_SECRET)}`
            }
          : {})
      });
    }
  };

  const listener = await sql.listen("overlay_events", (channelId) => {
    for (const connection of connections.get(channelId) ?? []) {
      deliverPending(connection).catch((error: unknown) =>
        app.log.error(error, "overlay delivery")
      );
    }
  });

  const add = (connection: OverlayConnection) => {
    const channel = connections.get(connection.channelId) ?? new Set();
    channel.add(connection);
    connections.set(connection.channelId, channel);
  };
  const remove = (connection: OverlayConnection) => {
    const channel = connections.get(connection.channelId);
    channel?.delete(connection);
    if (channel?.size === 0) connections.delete(connection.channelId);
  };

  app.get("/audio/:filename", async (request, reply) => {
    const { filename } = z.object({ filename: z.string() }).parse(request.params);
    const query = z
      .object({ expires: z.coerce.number().int(), sig: z.string() })
      .safeParse(request.query);
    if (
      !query.success ||
      !verifyAudioSignature(
        filename,
        query.data.expires,
        query.data.sig,
        config.AUDIO_SIGNING_SECRET
      )
    ) {
      return reply
        .code(403)
        .send({ error: { code: "invalid_signature", message: "Ссылка истекла" } });
    }
    const path = join(config.AUDIO_DIR, basename(filename));
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) {
      return reply.code(404).send({ error: { code: "not_found", message: "Аудио удалено" } });
    }
    reply.header("cache-control", "no-store");
    reply.header("content-length", String(metadata.size));
    reply.type("audio/wav");
    return reply.send(createReadStream(path));
  });

  app.get("/overlay/:token", { websocket: true }, (socket, request) => {
    const token = (request.params as { token: string }).token;
    let connection: OverlayConnection | undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    // Registered first and fully guarded: the socket is reachable before authentication, so a
    // malformed frame from anyone must never throw out of the ws receiver.
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      if (!connection) return;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw).toString("utf8");
        if (text.length > 4_096) return;
        const parsed = overlayClientEventSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.type === "overlay.ack") {
          sql`update overlay_events set status='delivered', delivered_at=now()
            where id=${parsed.data.eventId} and channel_id=${connection.channelId}`.catch(
            (error: unknown) => request.log.error(error, "overlay ack")
          );
        }
      } catch {
        // Ignore frames that are not valid JSON.
      }
    });
    socket.on("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (connection) remove(connection);
    });
    socket.on("error", (error) => request.log.warn(error, "overlay socket error"));

    void (async () => {
      const [channel] = await sql<
        { id: string }[]
      >`select id from channels where overlay_token=${token}`;
      if (!channel) return socket.close(1008, "invalid token");
      if (socket.readyState !== socket.OPEN) return;
      connection = { socket, channelId: channel.id, sent: new Set() };
      add(connection);
      sendJson(socket, {
        version: 1,
        type: "overlay.ready",
        eventId: randomUUID(),
        sentAt: new Date().toISOString()
      });
      heartbeat = setInterval(() => {
        sendJson(socket, {
          version: 1,
          type: "overlay.ping",
          eventId: randomUUID(),
          sentAt: new Date().toISOString()
        });
      }, 25_000);
      await deliverPending(connection);
    })().catch((error: unknown) => {
      request.log.error(error, "overlay connection");
      socket.close(1011);
    });
  });

  return {
    close(channelId, reason) {
      for (const connection of connections.get(channelId) ?? []) {
        connection.socket.close(1008, reason);
      }
    },
    connected(channelId) {
      return [...(connections.get(channelId) ?? [])].some(
        (connection) => connection.socket.readyState === connection.socket.OPEN
      );
    },
    async shutdown() {
      for (const channel of connections.values()) {
        for (const connection of channel) connection.socket.close(1001, "server shutdown");
      }
      await listener.unlisten();
    }
  };
}
