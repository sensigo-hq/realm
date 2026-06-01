import { describe, it, expect } from 'vitest';
import { VERSION } from './index.js';

describe('mcp-server', () => {
  it('exports VERSION', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
