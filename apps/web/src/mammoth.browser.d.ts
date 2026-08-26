declare module "mammoth/mammoth.browser" {
  interface ExtractResult {
    value: string;
    messages: unknown[];
  }
  interface ExtractOptions {
    arrayBuffer: ArrayBuffer;
  }
  export function extractRawText(options: ExtractOptions): Promise<ExtractResult>;
}
