/** Strip HTML tags and return plain text (for empty-checks). */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}
