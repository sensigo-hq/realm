import { describe, it, expect } from 'vitest';
import { VERSION } from './index.js';

describe('mcp-server', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.2.0');
  });
});
