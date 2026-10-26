-- The first ElevenLabs voices streamers choose from for their characters. Names are placeholders:
-- the owner renames them in /admin after listening. Mitsuki's and Ai's voices come from the
-- worker's environment at startup (syncVoices), together with the samples of all new voices.
INSERT INTO "voices" ("id", "label", "sort") VALUES
  ('tnjzWy46l6XmxM2yWKnN', 'Голос 1', 11),
  ('QSaGDZOf5RWf5LPBHH15', 'Голос 2', 12),
  ('9eaLrh9YGK2eNwzX4htv', 'Голос 3', 13),
  ('FZGeNF7bE3syeQOynDKC', 'Голос 4', 14),
  ('D5RRIJYa9pFwxiSpbGbR', 'Голос 5', 15)
ON CONFLICT ("id") DO NOTHING;
