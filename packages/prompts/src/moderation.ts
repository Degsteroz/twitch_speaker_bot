import { BLOCKLIST, RU_PREFIXES, type BlockCategory, type BlockTerm } from "./blocklist.js";

// Text is checked in three views, because evasions differ by script:
//   visual   — Latin and digit look-alikes become Cyrillic ("пuд0р", "xyй", "6ля");
//   phonetic — Latin is transliterated to Cyrillic ("pidor", "nahuy", "blyat", "nigger");
//   latin    — Cyrillic look-alikes and leetspeak become Latin ("nіgg3r", "f@g").
// Russian terms are checked in the first two, English terms in the third.

const INVISIBLE_OR_MARK = /[\p{Cf}\p{Mn}\p{Me}]/gu;
// Characters that stand in for a hidden letter inside a word: "п*дор", "бл#ть".
const MASK = "*#";
const TOKEN = /[\p{L}\p{N}*#]+/gu;
const MASK_RUN = /[*#]+/gu;

const VISUAL_TO_CYRILLIC: Readonly<Record<string, string>> = Object.freeze({
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  i: "и",
  j: "й",
  k: "к",
  m: "м",
  n: "п",
  o: "о",
  p: "р",
  r: "г",
  t: "т",
  u: "и",
  x: "х",
  y: "у",
  "0": "о",
  "1": "и",
  "3": "з",
  "4": "ч",
  "6": "б",
  "8": "в",
  "@": "а",
  і: "и",
  ї: "и",
  є: "е",
  ґ: "г"
});

const PHONETIC_DIGRAPHS: readonly (readonly [string, string])[] = [
  ["shch", "щ"],
  ["sch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["ts", "ц"],
  ["yo", "е"],
  ["jo", "е"],
  ["yu", "ю"],
  ["ju", "ю"],
  ["ya", "я"],
  ["ja", "я"],
  ["ye", "е"],
  ["je", "е"]
];
const PHONETIC_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  a: "а",
  b: "б",
  c: "с",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "й",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "х",
  z: "з",
  "0": "о",
  "1": "и",
  "3": "е",
  "4": "ч",
  "6": "б",
  "8": "в",
  "@": "а",
  і: "и",
  ї: "и",
  є: "е",
  ґ: "г"
});
const VOWELS = new Set("aeiouyаеиоуыэюяё");

const TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ѕ: "s",
  ј: "j",
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l"
});

// Short words that are never a fragment of a split-up slur; keeps "не грусти" from becoming
// "негрусти" and "ни героя" from becoming "нигероя".
const FUNCTION_WORDS = new Set(
  (
    "а и в к с у о я на не но ни да за до по от из ты мы вы он их же ли бы то уж вот как так что " +
    "это там тут все его ее мне нас вас для без при про под над уже еще или где кто чем тот эта эти " +
    "a i an at as be by do go he if in is it me my no of on or so to up us we the and you are not " +
    "but for all can her his him its our out she was who why yes"
  ).split(" ")
);

const CYRILLIC_FILLS = ["", "а", "е", "и", "о", "у", "ы", "я", "ю"];
const LATIN_FILLS = ["", "a", "e", "i", "o", "u", "y"];

/** Lower case, NFKC, no invisible characters or combining marks, ё folded into е. */
function fold(input: string): string {
  return input
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(INVISIBLE_OR_MARK, "")
    .replaceAll("ё", "е");
}

const mapChars = (text: string, table: Readonly<Record<string, string>>) =>
  Array.from(text, (character) => table[character] ?? character).join("");

function transliterate(text: string): string {
  let result = "";
  for (let index = 0; index < text.length;) {
    const digraph = PHONETIC_DIGRAPHS.find(([latin]) => text.startsWith(latin, index));
    if (digraph) {
      result += digraph[1];
      index += digraph[0].length;
      continue;
    }
    const character = text[index]!;
    if (character === "y") {
      // "huy" → хуй, "pidory" → пидоры.
      result += VOWELS.has(text[index - 1] ?? "") ? "й" : "ы";
    } else {
      result += PHONETIC_LETTERS[character] ?? character;
    }
    index += 1;
  }
  return result;
}

const collapseRepeats = (word: string) => word.replace(/(\p{L})\1+/gu, "$1");

interface TextView {
  /** Normalized words joined by single spaces, for multi-word terms. */
  readonly phrase: string;
  /** Every word form worth checking: words, filled-in masked words, re-joined fragments. */
  readonly candidates: readonly string[];
}

// "п и д о р" → "пидор": glue runs of 3+ single letters back together.
function joinSpelledOutWords(words: readonly string[]): string[] {
  const result: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) result.push(run.join(""));
    else result.push(...run);
    run = [];
  };
  for (const word of words) {
    if (Array.from(word).length === 1) run.push(word);
    else {
      flush();
      result.push(word);
    }
  }
  flush();
  return result;
}

// "пи дор", "пиз дец", "пидо р": joins of 2–3 neighbouring words where all but one are short
// fragments. Function words never take part.
function fragmentJoins(words: readonly string[]): string[] {
  const joins: string[] = [];
  for (let size = 2; size <= 3; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const window = words.slice(start, start + size);
      if (window.some((word) => FUNCTION_WORDS.has(word))) continue;
      const long = window.filter((word) => Array.from(word).length > 3).length;
      if (long <= 1) joins.push(collapseRepeats(window.join("")));
    }
  }
  return joins;
}

// A masked word is tried with each mask run replaced by nothing or by one vowel.
function fillMasks(word: string, fills: readonly string[]): string[] {
  const runs = word.match(MASK_RUN)?.length ?? 0;
  if (runs === 0) return [word];
  if (runs > 2) return [word.replace(MASK_RUN, "")];
  let variants = [word];
  for (let run = 0; run < runs; run += 1) {
    variants = variants.flatMap((variant) => fills.map((fill) => variant.replace(/[*#]+/u, fill)));
  }
  return variants;
}

function buildView(mapped: string, fills: readonly string[]): TextView {
  const rawWords = (mapped.match(TOKEN) ?? [])
    .map((word) => word.replace(new RegExp(`^[${MASK}]+|[${MASK}]+$`, "gu"), ""))
    .filter(Boolean);
  const plainWords = joinSpelledOutWords(rawWords.map((word) => word.replace(MASK_RUN, ""))).map(
    collapseRepeats
  );
  const candidates = new Set<string>(plainWords);
  for (const word of rawWords) {
    for (const variant of fillMasks(word, fills)) candidates.add(collapseRepeats(variant));
  }
  for (const join of fragmentJoins(plainWords)) candidates.add(join);
  return { phrase: plainWords.join(" "), candidates: [...candidates].filter(Boolean) };
}

interface TextViews {
  readonly visual: TextView;
  readonly phonetic: TextView;
  readonly latin: TextView;
}

function viewsOf(input: string): TextViews {
  const folded = fold(input);
  return {
    visual: buildView(mapChars(folded, VISUAL_TO_CYRILLIC), CYRILLIC_FILLS),
    phonetic: buildView(transliterate(folded), CYRILLIC_FILLS),
    latin: buildView(mapChars(folded, TO_LATIN), LATIN_FILLS)
  };
}

/** The visual-Cyrillic view as one string; kept for tests and diagnostics. */
export function normalizeForModeration(input: string): string {
  return viewsOf(input).visual.phrase;
}

const normalizeTerm = (term: string, view: keyof TextViews) => viewsOf(term)[view].phrase;

interface PreparedTerm extends BlockTerm {
  readonly normalized: string;
}

const PREPARED_BLOCKLIST: readonly PreparedTerm[] = BLOCKLIST.map((entry) => {
  const view = entry.script === "latin" ? "latin" : "visual";
  return {
    ...entry,
    normalized: normalizeTerm(entry.term, view),
    ...(entry.except ? { except: entry.except.map((word) => normalizeTerm(word, view)) } : {})
  };
});

function matchesWord(candidate: string, entry: PreparedTerm): boolean {
  const term = entry.normalized;
  if (entry.except?.some((innocent) => candidate.includes(innocent))) return false;
  switch (entry.kind) {
    case "exact":
      return candidate === term;
    case "word":
      return candidate.startsWith(term);
    case "prefixed":
      return (
        candidate.startsWith(term) ||
        RU_PREFIXES.some((prefix) => candidate.startsWith(prefix + term))
      );
    case "root":
      return candidate.includes(term);
  }
}

function matchesView(view: TextView, entry: PreparedTerm): boolean {
  // Multi-word terms: the words in a row, the last one possibly with an ending ("убей себяяя"),
  // or glued into one word, as nicknames do ("HeilHitler88").
  if (entry.normalized.includes(" ")) {
    const glued = entry.normalized.replaceAll(" ", "");
    return (
      ` ${view.phrase}`.includes(` ${entry.normalized}`) ||
      view.candidates.some((candidate) => candidate.includes(glued))
    );
  }
  return view.candidates.some((candidate) => matchesWord(candidate, entry));
}

// The 14/88 code and swastikas survive any letter normalization, so they are checked on raw text.
const EXTREMIST_PATTERNS = [/(?:^|\D)14\s*[/\\|.,:-]?\s*88(?:\D|$)/u, /[卐卍࿕࿖࿗࿘]/u] as const;

export interface ModerationMatch {
  readonly source: "global" | "channel";
  readonly term: string;
  readonly normalizedTerm: string;
  readonly category?: BlockCategory;
}

// What the bot never engages with or says, whatever the channel chose.
export const ALWAYS_BLOCKED: ReadonlySet<BlockCategory> = new Set([
  "slur_ethnic",
  "slur_lgbt",
  "slur_disability",
  "extremism",
  "self_harm"
]);

/**
 * The first stop-list hit. `categories` limits the built-in list (the 14/88 code and swastikas
 * count as extremism); admin and channel words always apply.
 */
export function findStopListMatch(
  input: string,
  extraTerms: readonly string[] = [],
  categories?: ReadonlySet<BlockCategory>
): ModerationMatch | null {
  const views = viewsOf(input);
  const raw = input.normalize("NFKC");
  if (
    (!categories || categories.has("extremism")) &&
    EXTREMIST_PATTERNS.some((pattern) => pattern.test(raw))
  ) {
    return { source: "global", term: "1488", normalizedTerm: "1488", category: "extremism" };
  }
  for (const entry of PREPARED_BLOCKLIST) {
    if (categories && !categories.has(entry.category)) continue;
    const hit =
      entry.script === "latin"
        ? matchesView(views.latin, entry)
        : matchesView(views.visual, entry) || matchesView(views.phonetic, entry);
    if (hit) {
      return {
        source: "global",
        term: entry.term,
        normalizedTerm: entry.normalized,
        category: entry.category
      };
    }
  }
  // Admin and channel words: whole word or word prefix, in every view.
  for (const term of extraTerms) {
    for (const view of ["visual", "phonetic", "latin"] as const) {
      const normalized = normalizeTerm(term, view);
      if (!normalized) continue;
      const entry: PreparedTerm = {
        term,
        normalized,
        kind: "word",
        category: "profanity",
        script: "ru"
      };
      if (matchesView(views[view], entry)) {
        return { source: "channel", term, normalizedTerm: normalized };
      }
    }
  }
  return null;
}

export function moderateText(
  input: string,
  extraTerms: readonly string[] = []
): { readonly allowed: true } | { readonly allowed: false; readonly match: ModerationMatch } {
  const match = findStopListMatch(input, extraTerms);
  return match ? { allowed: false, match } : { allowed: true };
}

// ---- prompt injection ---------------------------------------------------------------------

// A roast bot never needs to follow instructions from chat, so a message that tries to give the
// model orders is rejected before any API call instead of being passed along with a warning.
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(instruction|rule|prompt|guideline|polic|restriction|filter)/u,
  /\bsystem\s*(prompt|message|instruction)/u,
  /\b(you are now|from now on you|act as|pretend (to be|you)|roleplay as)\b/u,
  /\b(developer|dev|god|uncensored) mode\b/u,
  /\bjailbreak/u,
  /\b(repeat after me|say (exactly|verbatim|word for word)|letter by letter|backwards)\b/u,
  /\bnew (instructions|rules)\b/u,
  /(игнорир|игнор|забудь|забей на|отмени|обойди|не (следуй|соблюдай|слушай)).{0,40}(инструкц|правил|ограничен|промпт|запрет|фильтр)/u,
  /промпт/u,
  /систем\S* (инструкц|сообщен|подсказ|настройк)/u,
  /(ты теперь|теперь ты|отныне ты|с этого момента ты|представь,? что ты|вообрази,? что ты|притворись|веди себя как)/u,
  /(режим|мод) (разработчика|бога|без цензуры)|без цензуры|джейлбрейк/u,
  /повтори (за мной|дословно|слово в слово|точно|фразу|текст)/u,
  /(скажи|произнеси|напиши|озвучь|прочитай|выведи) (дословно|слово в слово|точно|ровно|по буквам|задом наперед|наоборот|фразу|текст)/u,
  /по буквам|задом наперед|в обратном порядке/u,
  /(новые|твои|свои) (инструкц|правил)/u,
  /<\/?\s*(system|assistant|developer|user|msg|viewer|game|reply|streamer|event|instructions?)\b/u,
  /\[\s*(system|систем|inst)/u
] as const;

function injectionViews(input: string): string[] {
  const folded = fold(input).replace(/\s+/gu, " ");
  return [folded, mapChars(folded, VISUAL_TO_CYRILLIC), mapChars(folded, TO_LATIN)];
}

export function detectPromptInjection(input: string): boolean {
  return injectionViews(input).some((view) =>
    INJECTION_PATTERNS.some((pattern) => pattern.test(view))
  );
}

// ---- whole-request checks -----------------------------------------------------------------

export type InputVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Nickname and message checks that run before any quota or API spend. The nickname is read
 * aloud, so it passes the whole list. The message is only data for the model: swearing or a
 * coarse word from a viewer is answered, not ignored; hate, extremism and self-harm are not.
 */
export function inspectInput(
  viewerLogin: string,
  message: string,
  extraTerms: readonly string[] = []
): InputVerdict {
  const nickname = findStopListMatch(viewerLogin, extraTerms);
  if (nickname) return { allowed: false, reason: `nickname:${nickname.term}` };
  const text = findStopListMatch(message, extraTerms, ALWAYS_BLOCKED);
  if (text) return { allowed: false, reason: `stop_word:${text.term}` };
  if (detectPromptInjection(message) || detectPromptInjection(viewerLogin)) {
    return { allowed: false, reason: "prompt_injection" };
  }
  return { allowed: true };
}

const LINK_OR_CONTACT =
  /(https?:\/\/|www\.|t\.me\/|[\p{L}\d-]+\.(ru|рф|com|net|org|tv|gg|io|me|xyz|su|ua|by|kz|info|online|site|store|link|ly)(?![\p{L}\d])|[\w.+-]+@[\w-]+\.\w+|\+?\d[\d\s()-]{8,}\d)/iu;
// Markers that only appear when the model quotes its own instructions.
const PROMPT_LEAK =
  /блок безопасности|<\s*\/?\s*(viewer|msg|game|reply|streamer|event)\b|промпт|system prompt/iu;
const ECHO_WORDS = 6;

function echoesInput(output: string, input: string): boolean {
  const inputWords = viewsOf(input).visual.phrase.split(" ").filter(Boolean);
  if (inputWords.length < ECHO_WORDS) return false;
  const outputPhrase = ` ${viewsOf(output).visual.phrase} `;
  for (let start = 0; start + ECHO_WORDS <= inputWords.length; start += 1) {
    if (outputPhrase.includes(` ${inputWords.slice(start, start + ECHO_WORDS).join(" ")} `)) {
      return true;
    }
  }
  return false;
}

// From which toxicity a reply may contain each loosened category; the rest is always blocked.
export const MAT_MIN_TOXICITY = 5;
export const INSULT_MIN_TOXICITY = 4;

/** Built-in categories a reply may not contain at this toxicity. */
export function outputBlockedCategories(toxicity: number): ReadonlySet<BlockCategory> {
  const blocked = new Set<BlockCategory>([...ALWAYS_BLOCKED, "sexual"]);
  if (toxicity < MAT_MIN_TOXICITY) blocked.add("profanity");
  if (toxicity < INSULT_MIN_TOXICITY) blocked.add("insult");
  return blocked;
}

/**
 * Deterministic checks on the model's reply, run before the classifier. Besides the stop list
 * they catch what a successful injection usually produces: links and contacts, a leaked prompt,
 * or the viewer's own text read out verbatim. Mat is allowed only at toxicity 5, coarse insults
 * from 4; slurs, extremism, self-harm and sexual humiliation never.
 */
export function inspectOutput(
  output: string,
  input: string,
  extraTerms: readonly string[] = [],
  toxicity = 1
): InputVerdict {
  const match = findStopListMatch(output, extraTerms, outputBlockedCategories(toxicity));
  if (match) return { allowed: false, reason: `stop_word:${match.term}` };
  if (LINK_OR_CONTACT.test(output)) return { allowed: false, reason: "link_or_contact" };
  if (PROMPT_LEAK.test(fold(output))) return { allowed: false, reason: "prompt_leak" };
  if (echoesInput(output, input)) return { allowed: false, reason: "echo_input" };
  return { allowed: true };
}
