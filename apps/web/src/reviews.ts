// Streamers' reviews on the landing page. Each one is published with the streamer's consent.

export interface Review {
  /** Twitch login: the link to the channel and the name shown. */
  channel: string;
  /** Profile picture from the Twitch CDN. */
  avatar: string;
  /** Slug of a Twitch clip from that stream, if there is one. */
  clip?: string;
  /** Paragraphs of the review, as the streamer said it. */
  text: readonly string[];
}

export const REVIEWS: readonly Review[] = [
  {
    channel: "psina__makimi",
    avatar:
      "https://static-cdn.jtvnw.net/jtv_user_pictures/849fec17-fdbd-44d0-9d2e-8304159d6838-profile_image-70x70.png",
    clip: "UglyTemperedAlfalfaHotPokket-J3fN3TJyXs57_ndX",
    text: [
      "Коротко про бота, если говорить: да, крутая штука — плюс активность для чата, плюс ответы на донаты с острыми шутками. Мне понравился сегодняшний стрим, это что-то необычное.",
      "Чат может сам себя развлекать, а ты как стример за компанию хихикаешь — крутая вещь, короче.",
      "10 забулленных мужиков из 10."
    ]
  }
];

/** Twitch plays an embedded clip only on the domain named in `parent`: the one serving the page. */
export const clipEmbedUrl = (clip: string, hostname: string) =>
  `https://clips.twitch.tv/embed?${new URLSearchParams({ clip, parent: hostname, autoplay: "false" }).toString()}`;
