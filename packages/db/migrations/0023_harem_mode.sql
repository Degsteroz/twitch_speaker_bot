-- Harem mode: after a reply the other heroine may argue back. Her line plays as a second overlay
-- event of the same roast (part 1), and the roast keeps what she said for moderation.
ALTER TABLE "roasts" ADD COLUMN "retort_text" text;
--> statement-breakpoint
ALTER TABLE "roasts" ADD COLUMN "retort_tone" "tone";
--> statement-breakpoint
ALTER TABLE "overlay_events" ADD COLUMN "part" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "overlay_events" ADD CONSTRAINT "overlay_events_part_check" CHECK ("part" IN (0, 1));
--> statement-breakpoint
DROP INDEX "overlay_events_roast_id_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "overlay_events_roast_part_uidx" ON "overlay_events" USING btree ("roast_id","part");
