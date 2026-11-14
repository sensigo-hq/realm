// Clause 2: bundle-local `process`. argv [] keeps realm-mcp's import-time isRunDirectly() false (K-14).
// cwd() returns a fixed folder: 0.49.0 calls it while it builds each reply (the redaction's exemption
// for the working folder), and with env {} the name reaches no reply.
export const process = {
  argv: [],
  env: {},
  platform: 'browser',
  cwd: () => '/demo',
  stderr: { write() {} },
};
