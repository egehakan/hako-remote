import assert from "node:assert/strict";
import { test } from "node:test";
import { fullHeight } from "../src/lib/full-height.ts";

const tab = {
  innerWidth: 393,
  innerHeight: 659,
  clientHeight: 659,
  screenWidth: 393,
  screenHeight: 852,
  homeScreenApp: false,
};

test("a browser tab is as tall as its viewport, never as tall as the screen", () => {
  assert.equal(fullHeight(tab), 659);
  // Zoomed in, the window reports the part in view; the containing block still has the real height.
  assert.equal(fullHeight({ ...tab, innerWidth: 196, innerHeight: 329 }), 659);
});

test("a home-screen app that starts short by the status bar fills the screen", () => {
  const launched = { ...tab, innerHeight: 793, clientHeight: 793, homeScreenApp: true };
  assert.equal(fullHeight(launched), 852);
  assert.equal(fullHeight({ ...launched, innerHeight: 852, clientHeight: 852 }), 852);
});

test("a home-screen app on its side uses the screen's short side", () => {
  const sideways = {
    ...tab,
    innerWidth: 852,
    innerHeight: 372,
    clientHeight: 372,
    homeScreenApp: true,
  };
  assert.equal(fullHeight(sideways), 393);
  assert.equal(fullHeight({ ...sideways, innerHeight: 393, clientHeight: 393 }), 393);
});

test("a home-screen app in a window of its own keeps the window's height", () => {
  const ipad = { screenWidth: 820, screenHeight: 1180, homeScreenApp: true };
  // Beside another app: narrower than the screen.
  assert.equal(
    fullHeight({ ...ipad, innerWidth: 320, innerHeight: 1156, clientHeight: 1156 }),
    1156,
  );
  // As wide as the screen but far shorter than a status bar explains.
  assert.equal(fullHeight({ ...ipad, innerWidth: 820, innerHeight: 600, clientHeight: 600 }), 600);
});
