// Each language's grammar is a file of its own, fetched the first time a file needs it.

import type { Extension } from "@codemirror/state";
import type { LanguageId } from "./language";

async function legacy(load: () => Promise<Record<string, unknown>>, name: string) {
  const [{ StreamLanguage }, modes] = await Promise.all([import("@codemirror/language"), load()]);
  return StreamLanguage.define(modes[name] as Parameters<typeof StreamLanguage.define>[0]);
}

export async function loadLanguage(language: LanguageId): Promise<Extension | null> {
  switch (language) {
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "shell":
      return legacy(() => import("@codemirror/legacy-modes/mode/shell"), "shell");
    case "toml":
      return legacy(() => import("@codemirror/legacy-modes/mode/toml"), "toml");
    case "swift":
      return legacy(() => import("@codemirror/legacy-modes/mode/swift"), "swift");
    case "text":
      return null;
  }
}
