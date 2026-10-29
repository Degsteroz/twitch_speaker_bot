-- Baseline before and after an optimization: what the roasts of the last 30 days cost, why some
-- were skipped, and how long the voice took. Read-only (selects only).
--   psql "$DATABASE_URL" -f scripts/baseline.sql
-- On the server: docker compose exec -T postgres psql -U <user> <db> < scripts/baseline.sql

-- Cost and count of roasts by model, source and tier
select model, source, tier,
  count(*) roasts,
  round(avg(cost_usd)::numeric, 5) avg_usd,
  round(sum(cost_usd)::numeric, 2) total_usd,
  round(avg(latency_ms)) avg_ms,
  percentile_cont(0.95) within group (order by latency_ms) p95_ms
from roasts
where created_at > now() - interval '30 days' and status in ('done','blocked_output')
group by 1,2,3 order by total_usd desc;

-- Skipped roasts by reason
select error, count(*) from roasts
where created_at > now() - interval '30 days' and status='skipped'
group by 1 order by 2 desc;

-- Latency by voice
select voice_provider, count(*),
  percentile_cont(0.95) within group (order by latency_ms) p95_ms
from roasts where created_at > now() - interval '30 days' and status='done'
group by 1;
