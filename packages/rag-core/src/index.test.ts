import * as api from './index';

describe('public API', () => {
  it('exports the factory and config error', () => {
    expect(typeof api.createRag).toBe('function');
    expect(typeof api.RagConfigError).toBe('function');
  });
});
