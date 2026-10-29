#!/usr/bin/env node
// Replays the output classifier on two models and shows where they disagree, before the owner
// switches `classifier_model` in /admin. It calls the real API and spends real money (cents on
// Haiku, about two dollars on Sonnet for the full run); nothing else runs it.
//
//   pnpm build
//   ANTHROPIC_API_KEY=… node scripts/classifier-eval.mjs
//   … --old claude-sonnet-5-5 --new claude-haiku-5-5 --levels 5,6 --real 200
//
// Cases: every stop-list example (MUST_BLOCK, MUST_ALLOW in packages/prompts/src/examples.ts) at
// every toxicity level, plus with --real N and DATABASE_URL the last N replies that went on air
// (status done), each at its own channel's level. Accepted when no case the old model blocks is
// allowed by the new one, and the models disagree on at most 3 % of the MUST_ALLOW cases.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFrom = (pkg) => createRequire(join(root, pkg, "package.json"));
const fromRoot = (path) => import(pathToFileURL(join(root, path)).href);

const { values: args } = parseArgs({
  options: {
    old: { type: "string", default: "claude-sonnet-5-5" },
    new: { type: "string", default: "claude-haiku-5-5" },
    levels: { type: "string", default: "1,2,3,4,5,6" },
    real: { type: "string", default: "0" },
    concurrency: { type: "string", default: "4" },
    all: { type: "boolean", default: false }
  }
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(
    [
      "classifier-eval: set ANTHROPIC_API_KEY to run it (it calls the real API and spends money).",
      "  pnpm build",
      "  ANTHROPIC_API_KEY=… node scripts/classifier-eval.mjs [--old MODEL] [--new MODEL]",
      "    [--levels 1,2,3,4,5,6] [--real N  (needs DATABASE_URL)] [--all  (print every row)]"
    ].join("\n")
  );
  process.exit(0);
}

for (const built of ["packages/prompts/dist/index.js", "services/worker/dist/models.js"]) {
  if (!existsSync(join(root, built))) {
    console.error(`classifier-eval: ${built} is missing, run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const prompts = await fromRoot("packages/prompts/dist/index.js");
const { MUST_ALLOW, MUST_BLOCK } = await fromRoot("packages/prompts/dist/examples.js");
const { modelRequest } = await fromRoot("services/worker/dist/models.js");
const Anthropic = (await import(requireFrom("services/worker").resolve("@anthropic-ai/sdk")))
  .default;
const client = new Anthropic({ maxRetries: 4 });

const levels = args.levels.split(",").map(Number);
if (levels.some((level) => !Number.isInteger(level) || level < 1 || level > 6)) {
  console.error("classifier-eval: --levels takes numbers from 1 to 6, e.g. 5,6");
  process.exit(1);
}
const cases = [
  ...MUST_BLOCK.flatMap((text) => levels.map((level) => ({ set: "MUST_BLOCK", text, level }))),
  ...MUST_ALLOW.flatMap((text) => levels.map((level) => ({ set: "MUST_ALLOW", text, level })))
];

const realLimit = Number(args.real);
if (realLimit > 0) {
  if (!process.env.DATABASE_URL) {
    console.error("classifier-eval: --real needs DATABASE_URL");
    process.exit(1);
  }
  const postgres = (await import(requireFrom("packages/db").resolve("postgres"))).default;
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const rows = await sql`select output_text text, toxicity level from roasts
    where status='done' and output_text is not null and created_at > now() - interval '30 days'
    order by created_at desc limit ${realLimit}`;
  await sql.end();
  cases.push(...rows.map((row) => ({ set: "REAL", text: row.text, level: row.level })));
}

const spent = { [args.old]: 0, [args.new]: 0 };
async function verdict(model, item) {
  try {
    const response = await client.beta.messages.create(
      modelRequest(
        model,
        "classify",
        prompts.classifierSystemPrompt(item.level),
        prompts.classifierInput(item.text)
      )
    );
    const usage = response.usage;
    spent[model] += prompts.calculateCostUsd(
      {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0
      },
      prompts.pricingForModel(response.model || model)
    );
    if (response.stop_reason === "refusal") return "block";
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ");
    return prompts.parseClassifierVerdict(text);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message.slice(0, 60) : "unknown"}`;
  }
}

console.log(
  `${String(cases.length)} cases × 2 models (${args.old} vs ${args.new}), levels ${args.levels}`
);
const results = new Array(cases.length);
let next = 0;
let done = 0;
async function worker() {
  while (next < cases.length) {
    const index = next++;
    const item = cases[index];
    const [before, after] = await Promise.all([verdict(args.old, item), verdict(args.new, item)]);
    results[index] = { ...item, before, after };
    done += 1;
    if (done % 50 === 0) process.stderr.write(`  ${String(done)}/${String(cases.length)}\n`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));

const short = (text) => (text.length > 60 ? `${text.slice(0, 57)}...` : text).replace(/\n/gu, " ");
console.log(`\n${"set".padEnd(11)}lvl  ${"old".padEnd(6)}${"new".padEnd(6)}text`);
for (const row of results) {
  const differs = row.before !== row.after;
  if (!differs && !args.all) continue;
  const mark = row.before === "block" && row.after === "allow" ? "!!" : differs ? "≠ " : "  ";
  console.log(
    `${mark}${row.set.padEnd(9)}${String(row.level).padEnd(5)}${row.before.padEnd(6)}${row.after.padEnd(6)}${short(row.text)}`
  );
}

const errors = results.filter(
  (row) => row.before.startsWith("error") || row.after.startsWith("error")
);
const differing = results.filter((row) => row.before !== row.after);
const critical = results.filter((row) => row.before === "block" && row.after === "allow");
const allowRows = results.filter((row) => row.set === "MUST_ALLOW");
const allowDiff = allowRows.filter((row) => row.before !== row.after);
const allowRate = allowRows.length ? (allowDiff.length / allowRows.length) * 100 : 0;
const realRows = results.filter((row) => row.set === "REAL");

console.log(`
cases:                       ${String(results.length)}
disagreements:               ${String(differing.length)}
critical (old block → new allow): ${String(critical.length)}
MUST_ALLOW disagreements:    ${String(allowDiff.length)} of ${String(allowRows.length)} (${allowRate.toFixed(1)} %)`);
if (realRows.length) {
  const blockedBy = (key) => realRows.filter((row) => row[key] === "block").length;
  console.log(
    `real replies blocked:        old ${String(blockedBy("before"))}, new ${String(blockedBy("after"))} of ${String(realRows.length)}`
  );
}
if (errors.length) console.log(`API errors:                  ${String(errors.length)} (rerun)`);
console.log(
  `spent:                       ${args.old} $${spent[args.old].toFixed(4)}, ${args.new} $${spent[args.new].toFixed(4)}`
);

const accepted = critical.length === 0 && allowRate <= 3 && errors.length === 0;
console.log(
  accepted
    ? `\nACCEPTED: ${args.new} can replace ${args.old} as the classifier (/admin → classifier_model).`
    : `\nNOT ACCEPTED: keep ${args.old}. Look at the !! rows first.`
);
process.exit(accepted ? 0 : 1);
