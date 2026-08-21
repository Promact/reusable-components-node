import { formatSender } from './shared';

describe('formatSender', () => {
  it('formats as "{name} <email>" consistently for every provider to reuse', () => {
    expect(formatSender({ name: 'Jane Doe', email: 'jane@example.com' })).toBe('Jane Doe <jane@example.com>');
  });
});
