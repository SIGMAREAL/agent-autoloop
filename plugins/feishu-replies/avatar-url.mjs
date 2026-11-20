// GitHub App avatars use /in/, while user avatars use /u/. Preserve the API's route instead of guessing from user.id.
export function canonicalAvatarUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "avatars.githubusercontent.com" ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/(u|in)\/[1-9]\d*$/.test(url.pathname)
    )
      return null;
    return `https://avatars.githubusercontent.com${url.pathname}?s=80&v=4`;
  } catch {
    return null;
  }
}
export const isAvatarUrl = (url) => typeof url === "string" && canonicalAvatarUrl(url) === url;
