export type WordKind = "prose" | "key" | "string" | "constant" | "punct";

export interface Word {
  kind: WordKind;
  text: string;
  at: number;
}

const TOKEN =
  /"(?:[^"\\]|\\.)*"|'[^'\s]*'|=(?:true|false|null|-?\d+(?:\.\d+)?[A-Za-z]*)\b|!=|=|\[|\]|\b(?:true|false|null)\b|\b[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+(?:\/[A-Za-z0-9._-]+)?|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z][A-Za-z0-9]*(?==[^=])/g;

const CONSTANT = /^(?:true|false|null)$/;
const PUNCT = /^(?:!=|=|\[|\])$/;

/**
 * The code inside words a cluster wrote, told from the prose around it:
 * quoted strings, field paths and label keys, the values set with `=`, and
 * the grammar between them. Live, a PodSecurity check read as one grey wall
 * of `container "sleeper" must set securityContext.capabilities.drop=["ALL"]`.
 */
export function clusterWords(text: string): Word[] {
  const words: Word[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index;
    if (at > last)
      words.push({ kind: "prose", text: text.slice(last, at), at: last });
    if (token.startsWith('"') || token.startsWith("'"))
      words.push({ kind: "string", text: token, at });
    else if (token.length > 1 && token.startsWith("=")) {
      words.push({ kind: "punct", text: "=", at });
      words.push({ kind: "constant", text: token.slice(1), at: at + 1 });
    } else if (PUNCT.test(token))
      words.push({ kind: "punct", text: token, at });
    else if (CONSTANT.test(token))
      words.push({ kind: "constant", text: token, at });
    else words.push({ kind: "key", text: token, at });
    last = at + token.length;
  }
  if (last < text.length)
    words.push({ kind: "prose", text: text.slice(last), at: last });
  return words;
}
