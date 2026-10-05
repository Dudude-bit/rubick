import type { ForwardNote } from "@/generated/types";
import { sayWords, type Saying } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** A note as the cluster's own words, kept whole, or as a sentence of ours. */
export function forwardNoteSaying(note: ForwardNote): string | Saying {
  switch (note.says) {
    case "said":
      return note.text;
    case "retrying":
      return {
        key: "forwardRetrying",
        values: { text: note.text, n: note.after_secs },
      };
    case "gaveUp":
      return {
        key: "forwardGaveUp",
        values: { text: note.text, n: note.attempts },
      };
    case "podGone":
      return { key: "forwardPodGone", values: { pod: note.pod } };
    case "waiting":
      return {
        key: "forwardWaiting",
        values: { pod: note.pod, kind: note.kind, name: note.name },
      };
    case "noReplacement":
      return {
        key: "forwardNoReplacement",
        values: { pod: note.pod, kind: note.kind, name: note.name },
      };
    case "searchFailed":
      return {
        key: "forwardSearchFailed",
        values: { pod: note.pod, text: note.text },
      };
    case "moved":
      return { key: "forwardMoved", values: { from: note.from } };
    case "noStream":
      return { key: "forwardNoStream" };
    case "listenerFailed":
      return { key: "forwardListenerFailed", values: { text: note.text } };
  }
}

export function forwardNoteWords(
  note: ForwardNote | null | undefined,
  t: T
): string | null {
  if (!note) return null;
  const said = forwardNoteSaying(note);
  return typeof said === "string" ? said : sayWords(said, t);
}
