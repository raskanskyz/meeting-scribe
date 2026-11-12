export interface RunOptions {
  /** model name/alias for this provider; '' = the CLI's own default */
  model: string
  timeoutMs: number
  /** screenshots the prompt refers to: the temp dir holding them and the files in it */
  images?: { dir: string; files: string[] }
}

/**
 * One AI command-line tool Meeting Scribe can drive for polish and summaries.
 * Adding a provider = one file implementing this plus a line in providers/index.ts.
 */
export interface Provider {
  id: string
  /** shown in the UI: "Polish with <name>" */
  name: string
  installUrl: string
  /** binary name probed on PATH, in common install dirs and via a login shell */
  binaryName: string
  candidatePaths: string[]
  /** model used when the settings field is empty ('' = let the CLI choose) */
  defaultModel: string
  /** whether run() can show screenshots to the model; false = OCR text only */
  supportsImages: boolean
  /** sentence in the screen-context prompt telling the model how to see the images */
  imageHint: string
  /** run one prompt and return the model's reply text (envelopes already unwrapped) */
  run(bin: string, prompt: string, opts: RunOptions): Promise<string>
}
