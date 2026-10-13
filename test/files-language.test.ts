import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf } from "../src/lib/files/language.ts";

test("the extension decides the language, in any case", () => {
  const cases: [string, string][] = [
    ["main.ts", "typescript"],
    ["App.tsx", "tsx"],
    ["index.mjs", "javascript"],
    ["Badge.jsx", "jsx"],
    ["package.json", "json"],
    ["tsconfig.jsonc", "json"],
    ["INDEX.HTML", "html"],
    ["site.css", "css"],
    ["README.md", "markdown"],
    ["app.py", "python"],
    ["main.rs", "rust"],
    ["main.go", "go"],
    ["deploy.sh", "shell"],
    ["compose.yml", "yaml"],
    ["Cargo.toml", "toml"],
    ["schema.sql", "sql"],
    ["View.swift", "swift"],
    ["Main.java", "java"],
    ["frame.c", "c"],
    ["frame.h", "c"],
    ["vec.cpp", "cpp"],
    ["vec.hpp", "cpp"],
    ["notes.txt", "text"],
    ["archive.tar.gz", "text"],
  ];
  for (const [name, language] of cases) assert.equal(languageOf(name), language, name);
});

test("well-known names without a telling extension are recognised", () => {
  assert.equal(languageOf(".zshrc"), "shell");
  assert.equal(languageOf(".env"), "shell");
  assert.equal(languageOf(".env.production"), "shell");
  assert.equal(languageOf("Cargo.lock"), "toml");
  assert.equal(languageOf(".prettierrc"), "json");
  // A dot file is not a file with an extension and no name.
  assert.equal(languageOf(".json"), "text");
  assert.equal(languageOf("Makefile"), "text");
});

test("a shebang decides when the name says nothing", () => {
  assert.equal(languageOf("deploy", "#!/usr/bin/env bash"), "shell");
  assert.equal(languageOf("run", "#!/bin/sh -e"), "shell");
  assert.equal(languageOf("tool", "#!/usr/bin/env python3"), "python");
  assert.equal(languageOf("cli", "#!/usr/bin/env node"), "javascript");
  assert.equal(languageOf("data", "# just a comment"), "text");
  // The name wins over the first line.
  assert.equal(languageOf("notes.md", "#!/bin/sh"), "markdown");
});
