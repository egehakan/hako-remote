// The prebuilt browser bundle of mammoth, as much of it as the Word preview uses.
declare module "mammoth/mammoth.browser.min.js" {
  type Message = { type: "warning" | "error"; message: string };
  const mammoth: {
    convertToHtml(
      input: { arrayBuffer: ArrayBuffer },
      options?: { externalFileAccess?: boolean; ignoreEmptyParagraphs?: boolean },
    ): Promise<{ value: string; messages: Message[] }>;
  };
  export default mammoth;
}
