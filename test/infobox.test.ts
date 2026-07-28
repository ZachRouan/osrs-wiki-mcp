import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseInfoboxes } from "../src/infobox";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}.txt`, import.meta.url)), "utf8");

/** Parse a fixture, failing loudly rather than returning null. */
function parseFixture(name: string) {
  const result = parseInfoboxes(fixture(name));
  expect(result, `expected an infobox in ${name}`).not.toBeNull();
  return result!;
}

describe("Topaz amulet (u) — crafting materials and level", () => {
  const result = parseFixture("topaz-amulet-u");

  it("reports Infobox Item as the primary template", () => {
    expect(result.template).toBe("Infobox Item");
    expect(result.fields.name).toBe("Topaz amulet (u)");
    expect(result.fields.id).toBe("21105");
    expect(result.fields.value).toBe("1275");
  });

  it("surfaces the exact materials: red topaz + silver bar (never a gold bar)", () => {
    const recipe = result.templates.find((t) => t.template === "Recipe");
    expect(recipe, "expected a Recipe template").toBeDefined();
    expect(recipe!.fields.mat1).toBe("Red topaz");
    expect(recipe!.fields.mat2).toBe("Silver bar");
    expect(Object.values(recipe!.fields).join(" ")).not.toMatch(/gold bar/i);
  });

  it("surfaces the 45 Crafting requirement", () => {
    const recipe = result.templates.find((t) => t.template === "Recipe")!;
    expect(recipe.fields.skill1).toBe("Crafting");
    expect(recipe.fields.skill1lvl).toBe("45");
    expect(recipe.fields.skill1exp).toBe("80");
  });

  it("converts [[File:...]] in the image field to a bare filename", () => {
    expect(result.fields.image).toBe("Topaz amulet (u).png");
  });

  it("is not treated as version-switched", () => {
    expect(result.versions).toBeUndefined();
  });
});

describe("Steel ring — plain infobox plus combat bonuses", () => {
  const result = parseFixture("steel-ring");

  it("parses the item infobox", () => {
    expect(result.template).toBe("Infobox Item");
    expect(result.fields.id).toBe("30895");
    expect(result.fields.value).toBe("15000");
    expect(result.fields.examine).toBe("A very old enchanted ring.");
    expect(result.fields.weight).toBe("3.000");
  });

  it("also returns the Infobox Bonuses template", () => {
    const bonuses = result.templates.find((t) => t.template === "Infobox Bonuses");
    expect(bonuses).toBeDefined();
    expect(bonuses!.fields.dstab).toBe("+24");
    expect(bonuses!.fields.dslash).toBe("+24");
    expect(bonuses!.fields.slot).toBe("ring");
  });
});

describe("Ensouled dragon head — version-switched infobox", () => {
  const result = parseFixture("ensouled-dragon-head");

  it("names Master Reanimation in the examine text", () => {
    expect(result.fields.examine).toMatch(/Master Reanimation/);
  });

  it("groups numbered params into versions while keeping shared params top-level", () => {
    expect(result.versions).toHaveLength(2);
    expect(result.versions![0].version).toBe("Drop");
    expect(result.versions![0].id).toBe("13510");
    expect(result.versions![0].tradeable).toBe("No");
    expect(result.versions![1].version).toBe("Item");
    expect(result.versions![1].id).toBe("13511");
    expect(result.versions![1].tradeable).toBe("Yes");

    // Shared params stay top-level and are not duplicated into versions.
    expect(result.fields.name).toBe("Ensouled dragon head");
    expect(result.fields.weight).toBe("0.453");
    expect(result.fields.id).toBeUndefined();
    expect(result.fields.tradeable).toBeUndefined();
  });

  it("strips <ref>/citation templates out of values", () => {
    expect(JSON.stringify(result.fields)).not.toMatch(/CiteTwitter|<ref/i);
  });
});

describe("Master Reanimation — the 90 Magic requirement is structured here", () => {
  const result = parseFixture("master-reanimation");

  it("parses Infobox Spell with level 90", () => {
    expect(result.template).toBe("Infobox Spell");
    expect(result.fields.level).toBe("90");
    expect(result.fields.spellbook).toBe("Arceuus");
    expect(result.fields.name).toBe("Master Reanimation");
  });

  it("keeps nested templates inside values intact", () => {
    // |cost = {{RuneReq|Nature=4|Blood=2|Soul=4}} — the nested pipes and equals
    // signs must not split the parameter or be mistaken for keys.
    expect(result.fields.cost).toContain("RuneReq");
    expect(result.fields.cost).toContain("Nature=4");
    expect(result.fields.cost).toContain("Soul=4");
  });
});

describe("Burning amulet — five charge versions", () => {
  const result = parseFixture("burning-amulet");

  it("groups all five versions", () => {
    expect(result.versions).toHaveLength(5);
    expect(result.versions![0].version).toBe("(1)");
    expect(result.versions![0].name).toBe("Burning amulet(1)");
    expect(result.versions![0].id).toBe("21175");
    expect(result.versions![4].version).toBe("(5)");
    expect(result.versions![4].id).toBe("21166");
    expect(result.versions![4].exchange).toBe("Yes");
  });

  it("keeps shared params top-level", () => {
    expect(result.fields.examine).toBe("Useful teleports around the wilderness.");
    expect(result.fields.defver).toBe("5");
    expect(result.fields.value).toBe("1250");
  });

  it("surfaces the enchant recipe: 49 Magic on a topaz amulet", () => {
    const recipe = result.templates.find((t) => t.template === "Recipe")!;
    expect(recipe.fields.skill1).toBe("Magic");
    expect(recipe.fields.skill1lvl).toBe("49");
    expect(recipe.fields.mat1).toBe("Topaz amulet");
    expect(recipe.fields.mat2).toBe("Cosmic rune");
    expect(recipe.fields.mat3).toBe("Fire rune");
    expect(recipe.fields.mat3quantity).toBe("5");
  });

  it("does not mistake Recipe's mat1/mat2/mat3 for version switching", () => {
    const recipe = result.templates.find((t) => t.template === "Recipe")!;
    expect(recipe.versions).toBeUndefined();
  });
});

describe("Dragon boots — multiple infoboxes on one page", () => {
  const result = parseFixture("dragon-boots");

  it("returns the item infobox as primary", () => {
    expect(result.template).toBe("Infobox Item");
    expect(result.fields.id).toBe("11840");
    expect(result.fields.value).toBe("20000");
  });

  it("returns combat stats from the second infobox rather than dropping them", () => {
    expect(result.templates.map((t) => t.template)).toEqual(
      expect.arrayContaining(["Infobox Item", "Infobox Bonuses"]),
    );
    const bonuses = result.templates.find((t) => t.template === "Infobox Bonuses")!;
    expect(bonuses.fields.str).toBe("+4");
    expect(bonuses.fields.dstab).toBe("+16");
    expect(bonuses.fields.dcrush).toBe("+18");
    expect(bonuses.fields.slot).toBe("feet");
  });
});

describe("parser edge cases", () => {
  it("returns null when the page has no infobox", () => {
    expect(parseInfoboxes("Just some prose with {{Coins|500}} and [[a link]].")).toBeNull();
  });

  it("does not split on pipes nested inside templates or links", () => {
    const wikitext = [
      "{{Infobox Item",
      "|name = Test item",
      "|drops = {{Coins|1|2}} plus [[Gold bar|a bar]]",
      "|examine = Fine.",
      "}}",
    ].join("\n");
    const result = parseInfoboxes(wikitext)!;
    expect(result.fields.drops).toBe("{{Coins|1|2}} plus a bar");
    expect(result.fields.examine).toBe("Fine.");
  });

  it("removes HTML comments from values", () => {
    const wikitext = "{{Infobox Item\n|name = Clean <!-- do not ship this --> name\n}}";
    expect(parseInfoboxes(wikitext)!.fields.name).toBe("Clean name");
  });

  it("matches Quest details templates", () => {
    const wikitext = "{{Quest details\n|start = Talk to [[Duke Horacio]]\n|difficulty = Novice\n}}";
    const result = parseInfoboxes(wikitext)!;
    expect(result.template).toBe("Quest details");
    expect(result.fields.start).toBe("Talk to Duke Horacio");
    expect(result.fields.difficulty).toBe("Novice");
  });

  it("ignores an unclosed template rather than throwing", () => {
    expect(() => parseInfoboxes("{{Infobox Item\n|name = Broken")).not.toThrow();
  });
});
