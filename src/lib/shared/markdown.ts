/**
 * Minimal defense-in-depth sanitizer for stored Markdown. It strips raw HTML and
 * dangerous link schemes before persistence; the frontend must still use a real
 * sanitizer when rendering Markdown as HTML.
 */
export function sanitizeMarkdown(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/!?\[([^\]]*)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, '$1')
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, ']()');
}
