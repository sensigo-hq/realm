// The child of test-location.test.ts (issue #715 (a), cell C15): a SEPARATE process that opens a JSON
// store on a test location's runs folder through the BUILT `@sensigo/realm`, creates one run, and
// prints ONE line: the run's `created_at` (an instant, never a value or a path).
/* global console, process */
process.on('unhandledRejection', () => process.exit(3));
const core = await import('@sensigo/realm');
const store = new core.JsonFileStore(process.argv[2]);
const { run } = await store.create({ workflowId: 'wf-715a-child', workflowVersion: 1, params: {} });
console.log(run.created_at);
