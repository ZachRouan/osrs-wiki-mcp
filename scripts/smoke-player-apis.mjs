#!/usr/bin/env node
/**
 * Hits the three live player-data APIs and pretty-prints what comes back.
 *
 * Deliberately NOT part of `npm test`: it depends on third-party services and
 * on an account's current state, so it would fail for reasons unrelated to this
 * codebase. Run it by hand when an upstream looks like it may have changed.
 *
 *   node scripts/smoke-player-apis.mjs [username]
 */

const USER_AGENT = "osrs-mcp/1.0 (personal project)";
const username = process.argv[2] ?? process.env.DEFAULT_PLAYER ?? "IronExample";
const encoded = encodeURIComponent(username);

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const ok = (s) => `[32m${s}[0m`;
const bad = (s) => `[31m${s}[0m`;

async function probe(label, url) {
  process.stdout.write(`${bold(label)}\n${dim(`  ${url}`)}\n`);
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const body = await response.text();
    const status = response.ok ? ok(`HTTP ${response.status}`) : bad(`HTTP ${response.status}`);
    console.log(`  ${status}  ${body.length} bytes`);

    if (!response.ok) {
      console.log(`  ${dim(body.slice(0, 120).replace(/\s+/g, " "))}\n`);
      return null;
    }
    try {
      return JSON.parse(body);
    } catch {
      console.log(`  ${bad("not JSON")} — ${dim(body.slice(0, 80))}\n`);
      return null;
    }
  } catch (error) {
    console.log(`  ${bad("request failed")}: ${error.message}\n`);
    return null;
  }
}

console.log(`\nSmoke-testing player APIs for ${bold(username)}\n${"─".repeat(60)}\n`);

const ironman = await probe(
  "1. Hiscores (ironman board)",
  `https://secure.runescape.com/m=hiscore_oldschool_ironman/index_lite.json?player=${encoded}`,
);
const standard = ironman
  ? null
  : await probe(
      "1b. Hiscores (standard board fallback)",
      `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encoded}`,
    );

const hiscores = ironman ?? standard;
if (hiscores) {
  const overall = hiscores.skills?.find((s) => s.name === "Overall");
  const ranked = (hiscores.activities ?? []).filter((a) => a.score > 0);
  console.log(`  board: ${ironman ? "ironman" : "standard"}`);
  console.log(`  total level ${overall?.level}, ${overall?.xp?.toLocaleString()} xp`);
  console.log(`  ${hiscores.skills?.length} skills, ${ranked.length} ranked activities\n`);
}

const sync = await probe(
  "2. WikiSync",
  `https://sync.runescape.wiki/runelite/player/${encoded}/STANDARD`,
);
if (sync) {
  const states = Object.values(sync.quests ?? {});
  const done = states.filter((s) => s === 2).length;
  console.log(`  synced ${sync.timestamp}`);
  console.log(`  ${done}/${states.length} quests complete`);
  console.log(`  ${Object.keys(sync.achievement_diaries ?? {}).length} diary regions\n`);
}

const wom = await probe("3. Wise Old Man (player)", `https://api.wiseoldman.net/v2/players/${encoded}`);
if (wom) {
  console.log(`  ${wom.type} / ${wom.build}, combat ${wom.combatLevel}`);
  console.log(`  ehp ${wom.ehp?.toFixed(1)}, ehb ${wom.ehb?.toFixed(1)}`);
  console.log(`  last updated ${wom.updatedAt}\n`);
}

for (const period of ["week", "year"]) {
  const gains = await probe(
    `4. Wise Old Man (gained, ${period})`,
    `https://api.wiseoldman.net/v2/players/${encoded}/gained?period=${period}`,
  );
  if (gains) {
    const skills = Object.entries(gains.data?.skills ?? {})
      .filter(([name, v]) => name !== "overall" && (v.experience?.gained ?? 0) > 0)
      .sort((a, b) => b[1].experience.gained - a[1].experience.gained);
    const total = gains.data?.skills?.overall?.experience?.gained ?? 0;
    console.log(`  ${total.toLocaleString()} xp across ${skills.length} skills`);
    if (skills.length > 0) {
      console.log(
        `  top: ${skills
          .slice(0, 3)
          .map(([n, v]) => `${n} +${v.experience.gained.toLocaleString()}`)
          .join(", ")}`,
      );
    } else {
      console.log(dim("  (no gains — WOM needs 2+ snapshots in the window)"));
    }
    console.log();
  }
}

console.log(`${"─".repeat(60)}\nDone.\n`);
