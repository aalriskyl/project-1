import { describe, expect, test } from 'bun:test';
import { sanitizeMarkdown } from '@/lib/shared/markdown.ts';

describe('sanitizeMarkdown', () => {
  test('strips raw HTML, comments, and dangerous link schemes', () => {
    const input =
      '<!-- hidden -->Hello <img src=x onerror=alert(1)> [click](javascript:alert(1)) ![pic](data:text/html,x) **safe**';
    const output = sanitizeMarkdown(input);

    expect(output).not.toContain('<img');
    expect(output).not.toContain('<!--');
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('data:text/html');
    expect(output).toContain('Hello');
    expect(output).toContain('**safe**');
  });
});
