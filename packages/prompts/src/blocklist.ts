// Built-in blocklist: compiled into the worker, applied to the viewer's nickname, the viewer's
// message and the model's reply, and impossible to switch off from /admin or a channel. Admin and
// channel stop words only add to it.
//
// Every term is matched after normalization (see moderation.ts): case, ё→е, homoglyphs, leetspeak,
// Latin transliteration ("pidor", "nahuy"), spaced or masked letters ("п и д о р", "п*дор") and
// repeated letters ("пииидор") all reduce to the same form. Write terms in plain lower case with
// doubled letters collapsed ("ниггер" → "нигер").
//
// Match kinds, from strict to loose:
//   exact    — the whole word only ("жид" but not "жидкий");
//   word     — a word that starts with the term ("дебил" → "дебилы");
//   prefixed — like word, but also after a Russian verb prefix ("ебал" → "заебал", "хуй" → "нахуй");
//   root     — anywhere inside a word ("пизд" → "распиздяй").
// `except` lists innocent words that contain the term; a word containing any of them is skipped.
// When adding a term, add an allowed example next to it in index.test.ts if it could collide.

export type MatchKind = "exact" | "word" | "prefixed" | "root";
export type BlockCategory =
  | "slur_ethnic"
  | "slur_lgbt"
  | "slur_disability"
  | "insult"
  | "profanity"
  | "sexual"
  | "self_harm"
  | "extremism";
export type Script = "ru" | "latin";

export interface BlockTerm {
  readonly term: string;
  readonly kind: MatchKind;
  readonly category: BlockCategory;
  readonly script: Script;
  readonly except?: readonly string[];
}

const group = (
  script: Script,
  category: BlockCategory,
  kind: MatchKind,
  terms: readonly string[],
  except?: readonly string[]
): BlockTerm[] =>
  terms.map((term) => ({ term, kind, category, script, ...(except ? { except } : {}) }));

// Prefixes that turn a profane root into another profane word: на-хуй, за-ебал, вы-блядок.
// Only used by the "prefixed" kind, so "сухую", "тихую", "себя", "дебаты" stay allowed.
export const RU_PREFIXES = Object.freeze([
  "на",
  "по",
  "ни",
  "за",
  "до",
  "от",
  "о",
  "об",
  "обо",
  "у",
  "вы",
  "раз",
  "рас",
  "без",
  "бес",
  "под",
  "при",
  "про",
  "пере",
  "недо",
  "с",
  "со",
  "из",
  "ис",
  "вз",
  "вс",
  "въ",
  "съ",
  "объ",
  "отъ",
  "подъ",
  "разъ",
  "изъ",
  "взъ",
  "долбо",
  "долба",
  "мудо"
]);

export const BLOCKLIST: readonly BlockTerm[] = Object.freeze([
  // Ethnic and national slurs.
  ...group("ru", "slur_ethnic", "root", ["нигер"], ["нигери"]),
  ...group("ru", "slur_ethnic", "word", ["негр"], ["негрони"]),
  ...group("ru", "slur_ethnic", "word", [
    "нига",
    "хохол",
    "москал",
    "кацап",
    "жидов",
    "жидяр",
    "жиденок",
    "чурк",
    "черножоп",
    "черномаз",
    "чучмек",
    "нерусь",
    "пиндос",
    "узкоглаз",
    "русня",
    "рашист"
  ]),
  ...group("ru", "slur_ethnic", "word", ["хохл"], ["хохлом"]),
  ...group("ru", "slur_ethnic", "exact", [
    "жид",
    "жида",
    "жиду",
    "жиды",
    "жидом",
    "жидам",
    "жидами",
    "жидах",
    "хач",
    "хачи",
    "хачей",
    "хачам",
    "хачами",
    "хачик",
    "хачики",
    "хачиков",
    "хачье"
  ]),

  // Homophobic and transphobic slurs.
  ...group("ru", "slur_lgbt", "root", ["пидор", "пидар", "пидр", "педераст", "педрил"]),
  ...group("ru", "slur_lgbt", "word", ["педик"], ["педикюр"]),
  ...group("ru", "slur_lgbt", "word", ["гомик", "гомосек", "гомосят", "лесбух", "трансух"]),

  // Disability slurs.
  ...group(
    "ru",
    "slur_disability",
    "word",
    ["даун"],
    ["даунгрейд", "даунтайм", "даунлоад", "дауншифт", "даунхил", "даунтаун", "даунтл"]
  ),
  ...group("ru", "slur_disability", "word", ["аутист", "инвалид", "калек", "спастик", "ретард"]),
  ...group("ru", "slur_disability", "exact", ["дцп", "дцпшник"]),

  // Coarse insults that are not about a real condition: fine in chat, in a reply only from
  // toxicity 4 (see moderation.ts).
  ...group("ru", "insult", "word", ["дебил", "имбецил", "олигофрен"]),

  // Russian mat.
  ...group("ru", "profanity", "prefixed", ["хуй", "хуе", "хуя", "хую", "хуи"]),
  ...group("ru", "profanity", "root", ["пизд", "пезд", "долбоеб", "долбаеб"]),
  ...group("ru", "profanity", "prefixed", [
    "ебал",
    "ебан",
    "ебат",
    "ебаш",
    "ебл",
    "ебн",
    "ебу",
    "ебет",
    "ебись",
    "ебок",
    "ебыр",
    "ебар"
  ]),
  ...group("ru", "profanity", "exact", ["еби", "бля"]),
  ...group("ru", "profanity", "prefixed", ["бляд", "блят"]),
  ...group("ru", "profanity", "word", [
    "сука",
    "сучк",
    "сучар",
    "мудак",
    "мудач",
    "мудил",
    "мудоз",
    "залуп",
    "гандон",
    "гондон",
    "мандавош"
  ]),
  // Not "word": "мандарин", "сукно".
  ...group("ru", "profanity", "exact", [
    "сукой",
    "суками",
    "сукам",
    "манда",
    "манду",
    "мандой",
    "манды"
  ]),

  // Sexual humiliation.
  ...group("ru", "sexual", "word", [
    "шлюх",
    "шалав",
    "давалк",
    "проститут",
    "дроч",
    "отсос",
    "минет",
    "трахн",
    "трахат",
    "трахал"
  ]),
  ...group("ru", "sexual", "exact", ["соси", "сосни", "отсоси"]),

  // Self-harm and death wishes.
  ...group("ru", "self_harm", "word", [
    "сдохни",
    "сдохнешь",
    "сдохните",
    "убейся",
    "повесься",
    "выпились",
    "вскройся",
    "застрелись",
    "утопись",
    "самоубейся",
    "убей себя",
    "убейте себя",
    "вскрой вены",
    "выпей яд"
  ]),

  // Nazi slogans (the 14/88 code and swastikas are matched separately in moderation.ts).
  ...group("ru", "extremism", "word", ["зиг хайль", "хайль гитлер", "слава гитлеру", "гитлер"]),

  // English: slurs, profanity, self-harm, Nazi slogans. Transliterated Russian ("pidor", "suka",
  // "nahuy") needs no entries here: it is transliterated and checked against the list above.
  ...group("latin", "slur_ethnic", "root", ["niger"], ["nigeri"]),
  ...group("latin", "slur_ethnic", "word", [
    "niga",
    "nignog",
    "wetback",
    "beaner",
    "raghead",
    "towelhead"
  ]),
  ...group("latin", "slur_ethnic", "word", ["negro"], ["negroni"]),
  ...group("latin", "slur_ethnic", "exact", [
    "kike",
    "kikes",
    "spic",
    "spics",
    "chink",
    "chinks",
    "gook",
    "gooks",
    "coon",
    "coons"
  ]),
  ...group("latin", "slur_lgbt", "word", ["fagot", "trany"]),
  ...group("latin", "slur_lgbt", "exact", ["fag", "fags", "dyke", "dykes"]),
  ...group("latin", "slur_disability", "word", ["retard"], ["retardant"]),
  ...group("latin", "profanity", "root", ["fuck"]),
  ...group("latin", "profanity", "word", ["cunt", "bitch", "whore", "slut", "rapist"]),
  ...group("latin", "profanity", "exact", ["rape", "raped"]),
  ...group("latin", "self_harm", "word", [
    "kill yourself",
    "kill urself",
    "kill your self",
    "neck yourself"
  ]),
  ...group("latin", "self_harm", "exact", ["kys"]),
  ...group("latin", "extremism", "word", ["heil hitler", "sieg heil", "white power", "hitler"])
]);
