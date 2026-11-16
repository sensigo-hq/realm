// Processor — stateless content transformation in a processing pipeline.

/**
 * The text and metadata a processor is given (`Processor.process`).
 * @public
 */
export interface ProcessorInput {
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * The text and metadata a processor returns; the next processor in the pipeline is given it.
 * @public
 */
export interface ProcessorOutput {
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * A program's step that changes content, registered under its `id` and run in order by
 * `runPipeline`.
 * @public
 */
export interface Processor {
  readonly id: string;
  process(content: ProcessorInput, config: Record<string, unknown>): Promise<ProcessorOutput>;
}
