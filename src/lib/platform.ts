/** An iPhone or an iPad, the latter also when it says it is a Mac. */
export const IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
