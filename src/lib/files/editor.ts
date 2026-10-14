// The file view's editor: CodeMirror dressed in Hako's colours, read-only until asked otherwise.

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import {
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const AMBER = "#e9a45f";
const CREAM = "#ecd2a2";
const SAGE = "#a3c7a0";
const SLATE = "#8fb1d8";
const CLAY = "#dd9a88";
const QUIET = "#a09b90";
const FAINT = "#77736c";

/**
 * Hako's own syntax colours: the box's amber for the words a language reserves, a cream for the
 * names of types, and three quieter hues for text, names being defined, and literal values.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: FAINT, fontStyle: "italic" },
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.self],
    color: AMBER,
  },
  { tag: [tags.string, tags.special(tags.string), tags.inserted], color: SAGE },
  { tag: [tags.regexp, tags.escape, tags.character], color: CLAY },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: CLAY },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.annotation, tags.macroName],
    color: CREAM,
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
      tags.labelName,
    ],
    color: SLATE,
  },
  { tag: [tags.tagName, tags.angleBracket], color: SLATE },
  { tag: [tags.attributeName, tags.propertyName], color: CREAM },
  { tag: [tags.attributeValue], color: SAGE },
  {
    tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.derefOperator],
    color: QUIET,
  },
  { tag: tags.heading, color: "#f6c984", fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: SLATE, textDecoration: "underline" },
  { tag: [tags.monospace, tags.quote, tags.contentSeparator], color: QUIET },
  { tag: tags.deleted, color: CLAY },
  { tag: tags.invalid, color: "#f2695c" },
]);

const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--background)",
      color: "var(--foreground)",
      fontSize: "13px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: '"Commit Mono", ui-monospace, "SF Mono", Menlo, monospace',
      lineHeight: "1.6",
      overscrollBehavior: "contain",
    },
    // Room under the last line, so it can be scrolled clear of a thumb or a keyboard.
    ".cm-content": { padding: "8px 0 35vh", caretColor: "var(--lid)" },
    ".cm-line": { padding: "0 16px 0 10px" },
    ".cm-gutters": {
      backgroundColor: "var(--background)",
      color: "var(--faint)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "2.25em",
      padding: "0 8px 0 max(8px, env(safe-area-inset-left))",
      fontSize: "11px",
      lineHeight: "20.8px",
    },
    ".cm-revealed-line": {
      backgroundColor: "color-mix(in oklab, var(--amber) 18%, transparent)",
      boxShadow: "inset 2px 0 0 var(--amber)",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--card) 85%, transparent)" },
    ".cm-cursor": { borderLeftColor: "var(--lid)", borderLeftWidth: "2px" },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in oklab, var(--amber) 30%, transparent)",
      borderRadius: "2px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklab, var(--amber) 75%, transparent)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "transparent",
      outline: "1px solid var(--input)",
    },
    ".cm-specialChar": { color: "var(--destructive)" },
    // Find has a bar of its own; CodeMirror's panel only has to exist for matches to be marked.
    ".cm-panels": { display: "none" },
  },
  { dark: true },
);

/** The indentation a file already uses, so Tab adds more of the same. */
function detectIndent(content: string): string {
  let spaces = 0;
  let seen = 0;
  for (const line of content.split("\n", 400)) {
    if (line.startsWith("\t")) return "\t";
    const width = line.length - line.trimStart().length;
    if (width === 0 || line.trim() === "") continue;
    spaces = spaces === 0 ? width : Math.min(spaces, width);
    if (++seen > 60) break;
  }
  return " ".repeat(spaces >= 2 && spaces <= 8 ? spaces : 2);
}

export type EditorEvents = {
  onDirtyChange: (dirty: boolean) => void;
  onFocusChange: (focused: boolean) => void;
  /** Cmd+S or Ctrl+S while editing. */
  onSave: () => void;
};

export type FindState = { total: number; current: number };

/** Marks the line a file was opened at, until another is. */
const revealLineEffect = StateEffect.define<number>();
const revealedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(revealLineEffect)) {
        next = Decoration.set([Decoration.line({ class: "cm-revealed-line" }).range(effect.value)]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const MAX_MATCHES = 9999;

export class CodeEditor {
  readonly view: EditorView;
  private saved: Text;
  private dirty = false;
  private readonly mode = new Compartment();
  private readonly wrapping = new Compartment();
  private readonly language = new Compartment();
  private readonly events: EditorEvents;

  constructor(parent: HTMLElement, content: string, wrap: boolean, events: EditorEvents) {
    this.events = events;
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          indentUnit.of(detectIndent(content)),
          EditorState.tabSize.of(4),
          syntaxHighlighting(highlightStyle),
          search({
            top: true,
            createPanel: () => ({ dom: document.createElement("div"), top: true }),
          }),
          this.language.of([]),
          this.wrapping.of(wrap ? EditorView.lineWrapping : []),
          this.mode.of(this.modeExtensions(false)),
          revealedLine,
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.checkDirty();
            if (update.focusChanged) events.onFocusChange(update.view.hasFocus);
          }),
        ],
      }),
    });
    this.saved = this.view.state.doc;
  }

  private modeExtensions(editing: boolean): Extension {
    if (!editing) return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    return [
      EditorView.contentAttributes.of({
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": "File contents",
      }),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            this.events.onSave();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
    ];
  }

  private checkDirty(): void {
    const dirty = !this.view.state.doc.eq(this.saved);
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.events.onDirtyChange(dirty);
  }

  setEditing(editing: boolean): void {
    this.view.dispatch({ effects: this.mode.reconfigure(this.modeExtensions(editing)) });
    if (editing) this.view.focus();
  }

  setWrap(wrap: boolean): void {
    this.view.dispatch({
      effects: this.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }

  setLanguage(language: Extension): void {
    this.view.dispatch({ effects: this.language.reconfigure(language) });
  }

  /** The document as it is now, to be handed to `markSaved` once the Mac has it. */
  snapshot(): Text {
    return this.view.state.doc;
  }

  text(lineEnding: string, doc: Text = this.view.state.doc): string {
    return doc.sliceString(0, doc.length, lineEnding);
  }

  /** `doc` is what was sent, which need not be what is on screen by the time the answer comes. */
  markSaved(doc: Text): void {
    this.saved = doc;
    this.checkDirty();
  }

  /** Puts back the text as it was last saved or read. */
  revert(): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: this.saved },
    });
  }

  /** Scrolls a line to the middle of the view and marks it, as opening a file at a line does. */
  revealLine(number: number): void {
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(Math.max(1, number), doc.lines));
    this.view.dispatch({
      selection: { anchor: line.from },
      effects: [
        revealLineEffect.of(line.from),
        EditorView.scrollIntoView(line.from, { y: "center" }),
      ],
    });
  }

  insert(text: string): void {
    this.view.dispatch(this.view.state.replaceSelection(text), { scrollIntoView: true });
  }

  tab(): void {
    insertTab(this.view);
  }

  undo(): void {
    undo(this.view);
  }

  redo(): void {
    redo(this.view);
  }

  openFind(): void {
    openSearchPanel(this.view);
  }

  closeFind(): void {
    closeSearchPanel(this.view);
  }

  /** Marks every match of `text` and says how many there are, and which one is selected. */
  find(text: string): FindState {
    const query = new SearchQuery({ search: text, caseSensitive: false, literal: true });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (!query.valid) return { total: 0, current: 0 };
    const selection = this.view.state.selection.main;
    const cursor = query.getCursor(this.view.state) as Iterator<{ from: number; to: number }>;
    let total = 0;
    let current = 0;
    for (let step = cursor.next(); !step.done && total < MAX_MATCHES; step = cursor.next()) {
      total++;
      if (step.value.from === selection.from && step.value.to === selection.to) current = total;
    }
    return { total, current };
  }

  /** Finds as the owner types: goes to the first match at or after where they are. */
  findFirst(text: string): FindState {
    const query = new SearchQuery({ search: text, caseSensitive: false, literal: true });
    if (query.valid) {
      type Matches = Iterator<{ from: number; to: number }>;
      const state = this.view.state;
      let match = (query.getCursor(state, state.selection.main.from) as Matches).next();
      if (match.done) match = (query.getCursor(state) as Matches).next();
      if (!match.done) {
        this.view.dispatch({
          selection: { anchor: match.value.from, head: match.value.to },
          effects: EditorView.scrollIntoView(match.value.from, { y: "center" }),
        });
      }
    }
    return this.find(text);
  }

  findStep(text: string, direction: 1 | -1): FindState {
    if (text === "") return { total: 0, current: 0 };
    this.find(text);
    if (direction === 1) findNext(this.view);
    else findPrevious(this.view);
    return this.find(text);
  }

  destroy(): void {
    this.view.destroy();
  }
}
