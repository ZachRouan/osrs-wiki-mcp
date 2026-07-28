import {
  findTemplates,
  splitTopLevelEquals,
  splitTopLevelPipes,
  stripComments,
  stripWikiMarkup,
  type WikiTemplate,
} from "./wikitext";

export interface ParsedTemplate {
  /** Template name as written, e.g. "Infobox Item". */
  template: string;
  /** Parameters shared across every version of the subject. */
  fields: Record<string, string>;
  /**
   * Present only for version-switched templates. Each entry holds the numbered
   * parameters for one version, with the trailing index removed from the key.
   */
  versions?: Array<Record<string, string>>;
}

export interface InfoboxResult extends ParsedTemplate {
  /** Every matched template on the page, in document order. */
  templates: ParsedTemplate[];
}

const INFOBOX_NAME = /^infobox\b/i;
/**
 * `Recipe` carries the materials and skill levels that infoboxes omit, and is
 * the whole point of asking "what do I need to make this?".
 */
const ALSO_WANTED = new Set(["quest details", "recipe"]);

function isInfoboxLike(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return INFOBOX_NAME.test(lower) || lower === "quest details";
}

function isWanted(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return INFOBOX_NAME.test(lower) || ALSO_WANTED.has(lower);
}

/**
 * Collect wanted templates. Templates that are not themselves wanted are
 * searched internally, so an infobox wrapped in a container template is still
 * found; a wanted template is taken whole and not descended into.
 */
function collectWanted(text: string, found: WikiTemplate[] = []): WikiTemplate[] {
  for (const template of findTemplates(text)) {
    if (isWanted(template.name)) found.push(template);
    else collectWanted(template.inner, found);
  }
  return found;
}

/** Parse `|key = value` pairs, preserving document order. */
function parseFields(inner: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const part of splitTopLevelPipes(inner).slice(1)) {
    const pair = splitTopLevelEquals(part);
    if (!pair) continue; // positional parameter — infoboxes do not use them

    const key = stripComments(pair[0]).trim();
    if (!key) continue;

    const value = stripWikiMarkup(pair[1]);
    if (value === "") continue; // empty parameters are noise, not data

    fields[key] = value;
  }
  return fields;
}

/**
 * Split numbered parameters into per-version objects.
 *
 * Only triggered by the presence of `versionN` parameters, which is how this
 * wiki marks a version-switched infobox. Without that marker, numbered
 * parameters are ordinary list items (`mat1`, `mat2`, `skill1lvl` in a Recipe)
 * and are left alone.
 */
function groupVersions(fields: Record<string, string>): {
  fields: Record<string, string>;
  versions?: Array<Record<string, string>>;
} {
  const versionIndexes = Object.keys(fields)
    .map((key) => /^version(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));

  if (versionIndexes.length === 0) return { fields };

  const count = Math.max(...versionIndexes);
  const shared: Record<string, string> = {};
  const versions: Array<Record<string, string>> = Array.from({ length: count }, () => ({}));

  for (const [key, value] of Object.entries(fields)) {
    const numbered = /^(.*?)(\d+)$/.exec(key);
    if (numbered) {
      const base = numbered[1];
      const index = Number(numbered[2]);
      if (base !== "" && index >= 1 && index <= count) {
        versions[index - 1][base] = value;
        continue;
      }
    }
    shared[key] = value;
  }

  return { fields: shared, versions };
}

function parseTemplate(template: WikiTemplate): ParsedTemplate {
  const { fields, versions } = groupVersions(parseFields(template.inner));
  return versions
    ? { template: template.name, fields, versions }
    : { template: template.name, fields };
}

/**
 * Parse every infobox-like template on a page.
 *
 * Returns null when the page has none. The primary template (`template` /
 * `fields` / `versions`) is the first real infobox, falling back to the first
 * match of any kind; `templates` always holds all of them.
 */
export function parseInfoboxes(wikitext: string): InfoboxResult | null {
  const matches = collectWanted(wikitext);
  if (matches.length === 0) return null;

  const templates = matches.map(parseTemplate);
  const primaryIndex = matches.findIndex((match) => isInfoboxLike(match.name));
  const primary = templates[primaryIndex === -1 ? 0 : primaryIndex];

  return { ...primary, templates };
}
