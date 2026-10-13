const UNITS = ["kB", "MB", "GB", "TB"];

/** A size as a person reads it: `812 B`, `12.4 kB`, `2.5 MB`. Powers of 1,000, as Finder counts. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 999.5 && unit < UNITS.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const YEAR = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When a file last changed, as short as it can be said: the time today, else the day. */
export function formatModified(mtime: number, now = Date.now()): string {
  if (mtime <= 0) return "";
  const then = new Date(mtime);
  const today = new Date(now);
  if (then.toDateString() === today.toDateString()) return TIME.format(then);
  return then.getFullYear() === today.getFullYear() ? DAY.format(then) : YEAR.format(then);
}

export function formatModifiedFull(mtime: number): string {
  return mtime > 0 ? FULL.format(new Date(mtime)) : "";
}

export function formatCount(count: number): string {
  return count.toLocaleString();
}
