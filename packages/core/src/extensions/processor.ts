// Processor — stateless content transformation in a processing pipeline.

/** @public */
export interface ProcessorInput {
  text: string;
  metadata: Record<string, unknown>;
}

/** @public */
export interface ProcessorOutput {
  text: string;
  metadata: Record<string, unknown>;
}

/** @public */
export interface Processor {
  readonly id: string;
  process(content: ProcessorInput, config: Record<string, unknown>): Promise<ProcessorOutput>;
}
