import { Hono } from "hono";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const skillsApi = new Hono();

const SKILLS_DIR = join(homedir(), ".claude", "skills");

interface SkillInfo {
  name: string;
  description: string;
  filename: string;
  size: number;
  source: string;
}

function parseSkillDescription(content: string): string {
  // Try frontmatter description field
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/description:\s*["']?(.*?)["']?\s*$/m);
    if (descMatch) return descMatch[1];
  }
  // First non-empty, non-heading, non-frontmatter line
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith("```")) continue;
    return trimmed.slice(0, 300);
  }
  return "";
}

skillsApi.get("/skills", (c) => {
  const skills: SkillInfo[] = [];

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Each skill is a directory with SKILL.md inside
        const skillFile = join(SKILLS_DIR, entry.name, "SKILL.md");
        try {
          const stat = statSync(skillFile);
          const content = readFileSync(skillFile, "utf-8");
          skills.push({
            name: entry.name,
            description: parseSkillDescription(content),
            filename: "SKILL.md",
            size: stat.size,
            source: "installed",
          });
        } catch {
          // Directory exists but no SKILL.md — check for other .md files
          try {
            const subFiles = readdirSync(join(SKILLS_DIR, entry.name)).filter(f => f.endsWith(".md"));
            for (const sf of subFiles) {
              const sfPath = join(SKILLS_DIR, entry.name, sf);
              const stat = statSync(sfPath);
              const content = readFileSync(sfPath, "utf-8");
              skills.push({
                name: sf.replace(/\.md$/, ""),
                description: parseSkillDescription(content),
                filename: sf,
                size: stat.size,
                source: entry.name,
              });
            }
          } catch {}
        }
      } else if (entry.name.endsWith(".md")) {
        // Root-level .md files
        const fullPath = join(SKILLS_DIR, entry.name);
        try {
          const stat = statSync(fullPath);
          const content = readFileSync(fullPath, "utf-8");
          skills.push({
            name: entry.name.replace(/\.md$/, ""),
            description: parseSkillDescription(content),
            filename: entry.name,
            size: stat.size,
            source: "global",
          });
        } catch {}
      }
    }
  } catch {}

  // Deduplicate: prefer "installed" (SKILL.md) over sub-file entries
  const seen = new Map<string, number>();
  for (let i = 0; i < skills.length; i++) {
    const existing = seen.get(skills[i].name);
    if (existing !== undefined) {
      // Keep the "installed" one (has SKILL.md), drop the sub-file
      if (skills[i].source === "installed") {
        skills[existing] = skills[i]; // replace sub-file with installed
      }
      skills.splice(i, 1);
      i--;
    } else {
      seen.set(skills[i].name, i);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return c.json(skills);
});

skillsApi.get("/skills/:name", (c) => {
  const name = c.req.param("name");

  // Check directory-based skill first
  const dirPath = join(SKILLS_DIR, name, "SKILL.md");
  try {
    const content = readFileSync(dirPath, "utf-8");
    const stat = statSync(dirPath);
    return c.json({ name, content, filename: "SKILL.md", size: stat.size, source: "installed" });
  } catch {}

  // Check root-level .md
  const rootPath = join(SKILLS_DIR, `${name}.md`);
  try {
    const content = readFileSync(rootPath, "utf-8");
    const stat = statSync(rootPath);
    return c.json({ name, content, filename: `${name}.md`, size: stat.size, source: "global" });
  } catch {}

  return c.json({ error: "Skill not found" }, 404);
});
