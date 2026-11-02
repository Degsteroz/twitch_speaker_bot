-- The landing demo speaks in ElevenLabs, but only within its own share of the monthly cap.
INSERT INTO "global_settings" ("key", "value") VALUES ('demo_elevenlabs_char_limit', '10000'::jsonb)
  ON CONFLICT ("key") DO NOTHING;
