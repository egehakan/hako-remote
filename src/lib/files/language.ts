// Which language a file is written in, judged by its name and, failing that, its first line.

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "html"
  | "css"
  | "markdown"
  | "python"
  | "rust"
  | "go"
  | "shell"
  | "yaml"
  | "toml"
  | "sql"
  | "swift"
  | "java"
  | "c"
  | "cpp"
  | "text";

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  webmanifest: "json",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  pyi: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  env: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
};

const BY_NAME: Record<string, LanguageId> = {
  ".zshrc": "shell",
  ".zshenv": "shell",
  ".zprofile": "shell",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
  ".env": "shell",
  ".envrc": "shell",
  "cargo.lock": "toml",
  pipfile: "toml",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".clang-format": "yaml",
};

const SHEBANGS: [RegExp, LanguageId][] = [
  [/\b(?:ba|z|k|da|fi)?sh\b/, "shell"],
  [/\bpython[0-9.]*\b/, "python"],
  [/\b(?:node|deno|bun)\b/, "javascript"],
];

export function languageOf(fileName: string, firstLine = ""): LanguageId {
  const name = fileName.toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  // `.env.example` and `.env.local` are still environment files.
  if (name.startsWith(".env.")) return "shell";
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const known = BY_EXTENSION[name.slice(dot + 1)];
    if (known) return known;
  }
  if (firstLine.startsWith("#!")) {
    for (const [pattern, language] of SHEBANGS) if (pattern.test(firstLine)) return language;
  }
  return "text";
}

const LABELS: Record<LanguageId, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  go: "Go",
  shell: "Shell",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  swift: "Swift",
  java: "Java",
  c: "C",
  cpp: "C++",
  text: "Plain text",
};

export function languageLabel(language: LanguageId): string {
  return LABELS[language];
}
