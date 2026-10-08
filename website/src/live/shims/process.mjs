// Clause 2: bundle-local `process`. argv [] keeps realm-mcp's import-time isRunDirectly() false (K-14).
export const process = { argv: [], env: {}, platform: 'browser', stderr: { write() {} } };
