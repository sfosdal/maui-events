// Title hygiene for the feed (applied to fresh events and to the archive on
// read-back, so the two agree and the merge keys match).

// Notices are not events: a playground closure or a construction notice on
// the Seattle Center calendar is information, not something to go to.
export const NOTICE_RE = /\b(closure|closed|notice|advisory|road work|construction)\b/i;
export const isNotice = (title) => NOTICE_RE.test(String(title || ''));

// Ticketmaster shouts: "ANDREA BOCELLI", "THE B-52s * DANCE THIS MESS AROUND
// TOUR". When a title has two or more all-caps words, they come down to Title
// Case — a single shouted word ("WEEZER: The Voyage", "JOURNEY - Final
// Frontier") is left as the act styles it, since one word is as likely a
// styled name (MGMT, KATSEYE) as a shout. Short acronyms stay (DJ, USA, UW,
// NHL) unless they are ordinary words (THE, AND, OF…); a few longer styled
// names are kept by list.
const KEEP = new Set(['MGMT', 'NOFX', 'KISS', 'TOOL', 'ABBA', 'INXS', 'WNBA', 'NWSL', 'NCAA', 'ESPN', 'KEXP', 'SIFF', 'USAA', 'KIRO', 'KOMO', 'KUOW', 'KING', 'KATSEYE', 'ODESZA', 'RÜFÜS', 'IDLES', 'HAIM', 'MUNA', 'JPEGMAFIA', 'NBA', 'NFL', 'NHL', 'MLB', 'MLS', 'MLR', 'UFC', 'WWE', 'AEW', 'PBR', 'NYE', 'LGBTQ', 'PNW', 'CEO', 'STEM', 'TEDX', 'EDM', 'USA', 'WSU', 'OSU', 'UAA', 'UAF', 'SEA', 'VIP', 'TBA', 'TBD', 'IPA', 'AI', 'EP', 'LP', 'UK', 'EU']);
const SMALL_WORDS = new Set(['THE', 'AND', 'OF', 'A', 'AN', 'IN', 'ON', 'AT', 'TO', 'FOR', 'VS', 'LIVE', 'TOUR', 'SHOW', 'NIGHT', 'DAY', 'ONE', 'TWO', 'ALL', 'NEW', 'BIG', 'OUT', 'UP', 'HIT', 'HOT', 'TOP', 'BAND', 'THIS', 'THAT', 'YOUR', 'OUR', 'YOU', 'ME', 'MY', 'WE', 'IT', 'IS', 'BE', 'BY', 'OR', 'NO', 'SO', 'DO', 'GO', 'WITH', 'FROM', 'INTO', 'OVER', 'LAST', 'NEXT', 'MORE', 'BEST', 'LOVE', 'LIFE', 'TIME', 'HOME', 'BACK', 'FEAT', 'PLUS', 'AFTER', 'PARTY', 'FINAL', 'WORLD', 'GREAT', 'YEARS', 'MUSIC', 'DANCE', 'ROCK', 'SOUL', 'JAZZ', 'BLUES', 'FOLK', 'PUNK', 'METAL', 'SONGS', 'HITS', 'STORY', 'RETURN', 'RETURNS', 'PRESENTS', 'PRESENT', 'FEATURING', 'ANNIVERSARY', 'CELEBRATION', 'SPECIAL', 'GUEST', 'GUESTS', 'FRIENDS', 'EVENING', 'MORNING', 'SUMMER', 'WINTER', 'SPRING', 'FALL', 'HOLIDAY', 'CHRISTMAS', 'HALLOWEEN',
  'EL', 'LA', 'LOS', 'LAS', 'DE', 'DEL', 'Y', 'EN', 'CON', 'UN', 'UNA', 'AL', 'LO', 'MI', 'TU', 'SU', 'SIN', 'POR', 'PARA', 'SOBRE', 'GIRA', 'NOCHE', 'FIESTA', 'VIVO', 'MUNDO', 'CARTAS', 'MESA']); // the Spanish articles and prepositions too (cancun-events, 2026-10-13: "EL Mundo DE Fede Vigevani" was keeping its two-letter words as acronyms)
const WORD = /^([^A-ZÀ-Þ]*)([A-ZÀ-Þ][A-ZÀ-Þ'’]*[A-ZÀ-Þ])([^A-ZÀ-Þ]*)$/; // leading punctuation, a run of capitals (an apostrophe inside is fine), trailing punctuation
const shouted = (tok) => { const m = tok.match(WORD); return m && m[2].length >= 2 && !/[a-z]/.test(tok) ? m : null; };
const isAcronym = (w) => !SMALL_WORDS.has(w) && (w.length <= 2 || (w.length === 3 && !/[AEIOU]/.test(w))); // UW, DJ, LA; NHL, WSU-style three-letter words without a vowel — NYC, PNW; a vowelled one (EVE, CUT) is a word unless listed (USA, UFC)
export function calmTitle(title) {
  const s = String(title || '');
  const toks = s.split(/(\s+)/);
  const loud = toks.filter((t) => shouted(t)).length;
  if (loud < 2) return s;
  return toks.map((t) => {
    const m = shouted(t); if (!m) return t;
    const w = m[2];
    if (KEEP.has(w) || isAcronym(w)) return t;
    return m[1] + w[0] + w.slice(1).toLowerCase() + m[3];
  }).join('');
}
