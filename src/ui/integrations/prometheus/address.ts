/**
 * The address without the credentials a basic-auth Prometheus is reached
 * through: `https://user:pass@host` is the one way this app has to send
 * them, and the file names that it does rather than what they are.
 */
export function addressOf(url: string): { shown: string; basic: boolean } {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const basic = !!parsed && (parsed.username !== "" || parsed.password !== "");
  if (parsed) {
    parsed.username = "";
    parsed.password = "";
  }
  return {
    shown: (parsed ? parsed.toString() : url)
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
    basic,
  };
}
