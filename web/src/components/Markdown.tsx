import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const MARKDOWN_PATTERN = /(^|\n)#{1,6}\s|\*\*[^*\n]+\*\*|(^|\n)\s*[-*]\s+\S|(^|\n)\s*\d+\.\s+\S|\|[^\n]+\|[^\n]+\||```|\[[^\]\n]+\]\([^)\n]+\)/;

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERN.test(text);
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [text]);
  return <div className={className ?? "markdown-body"} dangerouslySetInnerHTML={{ __html: html }} />;
}
