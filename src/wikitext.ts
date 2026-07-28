/**
 * Low-level wikitext scanning and cleanup.
 *
 * Everything here is pure so it can be unit tested against committed fixtures
 * without a Worker runtime. `infobox.ts` builds on the scanners below.
 */

export interface WikiTemplate {
  /** Template name as written, e.g. "Infobox Item". */
  name: string;
  /** Text between the outer `{{` and `}}`, including the name. */
  inner: string;
  start: number;
  /** Exclusive index just past the closing `}}`. */
  end: number;
}

/**
 * Index just past the `}}` that closes the `{{` at `start`, or -1 if unbalanced.
 * Nested templates are counted so values containing templates stay intact.
 */
function matchTemplateEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
    } else if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Index just past the `]]` closing the `[[` at `start`, or -1 if unbalanced. */
function matchLinkEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === "[" && text[i + 1] === "[") {
      depth++;
      i++;
    } else if (text[i] === "]" && text[i + 1] === "]") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** All top-level templates in `text`, outermost only, in document order. */
export function findTemplates(text: string): WikiTemplate[] {
  const found: WikiTemplate[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== "{" || text[i + 1] !== "{") continue;
    const end = matchTemplateEnd(text, i);
    if (end === -1) continue;
    const inner = text.slice(i + 2, end - 2);
    found.push({ name: templateName(inner), inner, start: i, end });
    i = end - 1;
  }
  return found;
}

function templateName(inner: string): string {
  const upToFirstPipe = splitTopLevelPipes(inner)[0] ?? "";
  return upToFirstPipe.trim();
}

/**
 * Split on `|` characters that sit at nesting depth zero.
 *
 * Nested templates, wikilinks, wiki tables and HTML comments are skipped so a
 * pipe inside `{{Coins|...}}` or `[[a|b]]` never splits a parameter.
 */
export function splitTopLevelPipes(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let linkDepth = 0;
  let tableDepth = 0;

  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith("<!--", i)) {
      const close = inner.indexOf("-->", i);
      const stop = close === -1 ? inner.length : close + 3;
      current += inner.slice(i, stop);
      i = stop - 1;
      continue;
    }
    const pair = inner.slice(i, i + 2);
    if (pair === "{{") {
      braceDepth++;
      current += pair;
      i++;
      continue;
    }
    if (pair === "}}" && braceDepth > 0) {
      braceDepth--;
      current += pair;
      i++;
      continue;
    }
    if (pair === "[[") {
      linkDepth++;
      current += pair;
      i++;
      continue;
    }
    if (pair === "]]" && linkDepth > 0) {
      linkDepth--;
      current += pair;
      i++;
      continue;
    }
    if (pair === "{|") {
      tableDepth++;
      current += pair;
      i++;
      continue;
    }
    if (pair === "|}" && tableDepth > 0) {
      tableDepth--;
      current += pair;
      i++;
      continue;
    }
    if (inner[i] === "|" && braceDepth === 0 && linkDepth === 0 && tableDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += inner[i];
  }
  parts.push(current);
  return parts;
}

/**
 * Split a template parameter into `[key, value]` at the first top-level `=`.
 * Returns null for positional parameters.
 */
export function splitTopLevelEquals(part: string): [string, string] | null {
  let braceDepth = 0;
  let linkDepth = 0;

  for (let i = 0; i < part.length; i++) {
    if (part.startsWith("<!--", i)) {
      const close = part.indexOf("-->", i);
      i = (close === -1 ? part.length : close + 3) - 1;
      continue;
    }
    const pair = part.slice(i, i + 2);
    if (pair === "{{") {
      braceDepth++;
      i++;
      continue;
    }
    if (pair === "}}" && braceDepth > 0) {
      braceDepth--;
      i++;
      continue;
    }
    if (pair === "[[") {
      linkDepth++;
      i++;
      continue;
    }
    if (pair === "]]" && linkDepth > 0) {
      linkDepth--;
      i++;
      continue;
    }
    if (part[i] === "=" && braceDepth === 0 && linkDepth === 0) {
      return [part.slice(0, i), part.slice(i + 1)];
    }
  }
  return null;
}

export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function stripRefs(text: string): string {
  return text
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<references[^>]*\/>/gi, "")
    .replace(/<references[^>]*>[\s\S]*?<\/references>/gi, "");
}

type FileHandling = "filename" | "drop";

/** Render one `[[...]]` link body to plain text. */
function renderLink(inner: string, files: FileHandling): string {
  const segments = splitTopLevelPipes(inner);
  const target = (segments[0] ?? "").trim();

  if (/^:?category:/i.test(target)) return "";
  if (/^:?(file|image):/i.test(target)) {
    if (files === "drop") return "";
    return target.replace(/^:?(file|image):/i, "").trim();
  }
  // `[[link|text]]` -> text, `[[link]]` -> link
  const display = segments.length > 1 ? segments[segments.length - 1] : target;
  return display.trim();
}

/** Convert every wikilink in `text` to plain text. */
export function replaceLinks(text: string, files: FileHandling = "filename"): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[" && text[i + 1] === "[") {
      const end = matchLinkEnd(text, i);
      if (end !== -1) {
        const inner = text.slice(i + 2, end - 2);
        out += replaceLinks(renderLink(inner, files), files);
        i = end - 1;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

/**
 * Clean a single infobox parameter value: comments, refs, links, emphasis and
 * stray HTML go away. Templates are deliberately preserved — a value like
 * `{{RuneReq|Nature=4}}` still carries the information the model needs.
 */
export function stripWikiMarkup(value: string): string {
  let out = stripRefs(stripComments(value));
  out = replaceLinks(out, "filename");
  out = out.replace(/'''''(.*?)'''''/g, "$1");
  out = out.replace(/'''(.*?)'''/g, "$1");
  out = out.replace(/''(.*?)''/g, "$1");
  out = out.replace(/<br\s*\/?>/gi, " ");
  out = out.replace(/<\/?(?:small|big|sup|sub|b|i|u|span|div|nowrap|nowiki)[^>]*>/gi, "");
  out = decodeEntities(out);
  return out.replace(/[ \t]+/g, " ").trim();
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

export function stripHtml(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Templates that carry no information for a language model: citations,
 * hatnotes and table scaffolding.
 */
const NOISE_TEMPLATES = [
  "reflist",
  "references",
  "cite",
  "external",
  "redirect",
  "confuse",
  "otheruses",
  "hatnote",
  "subject changes header",
  "subject changes footer",
  "uses material list",
  "drop sources",
  "used in recommended equipment",
  "tablebottom",
  "navbox",
];

function isNoiseTemplate(name: string): boolean {
  const lower = name.toLowerCase();
  return NOISE_TEMPLATES.some((n) => lower === n || lower.startsWith(`${n} `) || lower.startsWith(n));
}

/**
 * Prepare page wikitext for the model: drop navboxes and references, flatten
 * links, and remove file/category noise.
 *
 * A parameterless template sitting alone on its line is a navbox by
 * convention on this wiki (`{{Amulets}}`, `{{Dragon equipment}}`), so those are
 * dropped too. Templates carrying parameters — infoboxes, recipes — are kept.
 */
export function cleanPageWikitext(text: string): string {
  let out = stripRefs(stripComments(text));

  const templates = findTemplates(out);
  // Remove from the end so earlier offsets stay valid.
  for (let i = templates.length - 1; i >= 0; i--) {
    const tpl = templates[i];
    const parameterless = splitTopLevelPipes(tpl.inner).length === 1;
    const lineStart = out.lastIndexOf("\n", tpl.start) + 1;
    const beforeIsBlank = out.slice(lineStart, tpl.start).trim() === "";
    const afterIsBlank = out.slice(tpl.end, out.indexOf("\n", tpl.end) === -1 ? out.length : out.indexOf("\n", tpl.end)).trim() === "";
    const isOwnLineNavbox = parameterless && beforeIsBlank && afterIsBlank;

    if (isNoiseTemplate(tpl.name) || isOwnLineNavbox) {
      out = out.slice(0, tpl.start) + out.slice(tpl.end);
    }
  }

  out = replaceLinks(out, "drop");
  out = decodeEntities(out);
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * Return the `==Section==` named `section`, including any nested subsections,
 * or null when the page has no such heading.
 */
export function extractSection(text: string, section: string): string | null {
  const lines = text.split("\n");
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const wanted = normalize(section.replace(/^=+|=+$/g, ""));
  const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/;

  let startLine = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = heading.exec(lines[i]);
    if (!match) continue;
    if (startLine === -1) {
      if (normalize(match[2]) === wanted) {
        startLine = i;
        startLevel = match[1].length;
      }
      continue;
    }
    if (match[1].length <= startLevel) {
      return lines.slice(startLine, i).join("\n").trim();
    }
  }
  return startLine === -1 ? null : lines.slice(startLine).join("\n").trim();
}

export const MAX_PAGE_CHARS = 12000;

export function truncateWithNotice(text: string, max: number = MAX_PAGE_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return (
    `${text.slice(0, max)}\n\n[Output truncated at ${max} characters; ${dropped} more remain. ` +
    `Call get_page again with the "section" argument to read a specific section in full.]`
  );
}
