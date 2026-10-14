// `/__hako/client.js`: the script the relay puts first into every page of a preview. It maps the
// dev servers' `localhost` addresses to preview origins before anything reaches the network, and
// tells the app framing it where the page is and what it logged.

import { createHash } from "node:crypto";
import {
  PREVIEW_CONSOLE_MAX,
  PREVIEW_CONSOLE_TEXT_MAX,
  PREVIEW_MESSAGE_TYPE,
} from "../../shared/previews.ts";

export type ClientScriptConfig = {
  appOrigins: readonly string[];
  /** Each port of the preview with the origin it is served on. */
  ports: readonly { port: number; origin: string }[];
};

// Plain ES2017 that any browser a preview runs in understands, with no dependencies. Every patch is
// wrapped so a page that changed the same thing first still loads.
const SOURCE = String.raw`(function () {
  "use strict";
  if (window.__hakoPreview) return;
  window.__hakoPreview = true;
  var C = __CONFIG__;
  var TYPE = ${JSON.stringify(PREVIEW_MESSAGE_TYPE)};
  var MAX = ${PREVIEW_CONSOLE_MAX};
  var TEXT_MAX = ${PREVIEW_CONSOLE_TEXT_MAX};
  var byPort = {};
  C.ports.forEach(function (p) { byPort[String(p.port)] = p.origin; });
  var LOCAL = /^(\s*)(https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(?=[\/?#]|$)/i;

  function mapUrl(value) {
    if (typeof value !== "string") return value;
    var m = LOCAL.exec(value);
    if (!m) return value;
    var scheme = m[2].toLowerCase();
    var port = m[3] || (scheme === "https" || scheme === "wss" ? "443" : "80");
    var origin = byPort[port];
    if (!origin) return value;
    if (scheme === "ws" || scheme === "wss") origin = origin.replace(/^http/, "ws");
    return m[1] + origin + value.slice(m[0].length);
  }
  function mapAny(input) {
    if (typeof input === "string") return mapUrl(input);
    if (input instanceof URL) {
      var mapped = mapUrl(input.href);
      return mapped === input.href ? input : new URL(mapped);
    }
    return input;
  }
  function mapSrcset(value) {
    return value.split(",").map(function (part) {
      var m = /^(\s*)(\S+)(.*)$/.exec(part);
      return m ? m[1] + mapUrl(m[2]) + m[3] : part;
    }).join(",");
  }
  function attempt(patch) { try { patch(); } catch (e) { /* left as it was */ } }

  attempt(function () {
    var original = window.fetch;
    if (!original) return;
    window.fetch = function (input, init) {
      if (typeof Request !== "undefined" && input instanceof Request) {
        var url = mapUrl(input.url);
        if (url !== input.url) input = new Request(url, input);
      } else {
        input = mapAny(input);
      }
      return original.call(this, input, init);
    };
  });
  attempt(function () {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      var args = Array.prototype.slice.call(arguments);
      args[1] = mapAny(args[1]);
      return open.apply(this, args);
    };
  });
  attempt(function () {
    var WS = window.WebSocket;
    if (!WS) return;
    var Mapped = function WebSocket(url, protocols) {
      return arguments.length > 1 ? new WS(mapAny(url), protocols) : new WS(mapAny(url));
    };
    Mapped.prototype = WS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { Mapped[k] = WS[k]; });
    window.WebSocket = Mapped;
  });
  attempt(function () {
    var ES = window.EventSource;
    if (!ES) return;
    var Mapped = function EventSource(url, init) { return new ES(mapAny(url), init); };
    Mapped.prototype = ES.prototype;
    ["CONNECTING", "OPEN", "CLOSED"].forEach(function (k) { Mapped[k] = ES[k]; });
    window.EventSource = Mapped;
  });
  attempt(function () {
    var beacon = navigator.sendBeacon;
    if (!beacon) return;
    navigator.sendBeacon = function (url, data) { return beacon.call(navigator, mapAny(url), data); };
  });
  attempt(function () {
    var open = window.open;
    window.open = function (url) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = mapAny(url);
      return open.apply(window, args);
    };
  });
  ["assign", "replace"].forEach(function (name) {
    attempt(function () {
      var original = Location.prototype[name];
      if (!original) return;
      Location.prototype[name] = function (url) { return original.call(this, mapAny(url)); };
    });
  });

  var ATTRIBUTES = ["src", "srcset", "href", "action", "poster", "data"];
  function fixElement(el) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < ATTRIBUTES.length; i++) {
      var name = ATTRIBUTES[i];
      var value = el.getAttribute(name);
      if (value === null) continue;
      var mapped = name === "srcset" ? mapSrcset(value) : mapUrl(value);
      if (mapped !== value) el.setAttribute(name, mapped);
    }
  }
  function fixTree(node) {
    if (!node || node.nodeType !== 1) return;
    fixElement(node);
    var all = node.querySelectorAll("[src],[srcset],[href],[action],[poster],[data]");
    for (var i = 0; i < all.length; i++) fixElement(all[i]);
  }
  attempt(function () {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "attributes") fixElement(r.target);
        else for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRIBUTES });
    fixTree(document.documentElement);
  });
  document.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("a[href],area[href]") : null;
    if (el) fixElement(el);
  }, true);
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (form && form.nodeType === 1) fixElement(form);
    var submitter = event.submitter;
    if (submitter && submitter.getAttribute) {
      var action = submitter.getAttribute("formaction");
      if (action !== null && mapUrl(action) !== action) submitter.setAttribute("formaction", mapUrl(action));
    }
  }, true);

  // Talking to the app that frames the page.
  var framed = window.parent !== window;
  function post(message) {
    if (!framed) return;
    message.type = TYPE;
    for (var i = 0; i < C.appOrigins.length; i++) {
      try { window.parent.postMessage(message, C.appOrigins[i]); } catch (e) { /* not that one */ }
    }
  }
  var last = "";
  function report() {
    var state = [location.href, document.title, window.innerWidth, window.innerHeight].join("\n");
    if (state === last) return;
    last = state;
    post({ kind: "location", url: location.href, title: String(document.title || "").slice(0, 300),
      width: window.innerWidth, height: window.innerHeight });
  }
  ["pushState", "replaceState"].forEach(function (name) {
    attempt(function () {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        report();
        return result;
      };
    });
  });
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  window.addEventListener("resize", report);
  window.addEventListener("load", report);
  document.addEventListener("DOMContentLoaded", report);
  setInterval(report, 1000);
  report();

  var sent = 0;
  function text(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function logged(level, message, source, line) {
    if (!framed || sent >= MAX) return;
    sent += 1;
    post({ kind: "console", level: level, message: String(message).slice(0, TEXT_MAX),
      source: source ? String(source).slice(0, TEXT_MAX) : null,
      line: typeof line === "number" && isFinite(line) ? line : null });
  }
  ["error", "warn"].forEach(function (level) {
    attempt(function () {
      var original = console[level];
      console[level] = function () {
        try {
          logged(level, Array.prototype.map.call(arguments, text).join(" "), null, null);
        } catch (e) { /* never in the page's way */ }
        return original.apply(this, arguments);
      };
    });
  });
  window.addEventListener("error", function (event) {
    if (!(event instanceof ErrorEvent)) return;
    logged("error", event.message || text(event.error), event.filename, event.lineno);
  });
  window.addEventListener("unhandledrejection", function (event) {
    logged("error", "Unhandled rejection: " + text(event.reason), null, null);
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || C.appOrigins.indexOf(event.origin) === -1) return;
    var data = event.data;
    if (!data || data.type !== TYPE) return;
    if (data.kind === "back") history.back();
    else if (data.kind === "forward") history.forward();
    else if (data.kind === "reload") location.reload();
    else if (data.kind === "navigate" && typeof data.path === "string" &&
      /^\/(?!\/)/.test(data.path) && !/[\\\u0000-\u001f]/.test(data.path)) {
      var target = new URL(data.path, location.origin);
      if (target.origin === location.origin) location.assign(target.href);
    }
  });
})();
`;

/** The script for one preview, and a version that changes whenever it does. */
export function clientScript(config: ClientScriptConfig): { source: string; version: string } {
  const source = SOURCE.replace("__CONFIG__", JSON.stringify(config).replace(/</g, "\\u003c"));
  const version = createHash("sha256").update(source).digest("base64url").slice(0, 12);
  return { source, version };
}
