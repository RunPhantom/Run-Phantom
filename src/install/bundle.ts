import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSkillFiles } from "../init-skills";

export interface SkillBundle {
  root: string;
  skillsDir: string;
  skills: { name: string; path: string }[];
}

function defaultBundleRoot(): string {
  return path.join(os.homedir(), ".runphantom", "bundles", "current");
}

export async function materializeSkillBundle(root: string = defaultBundleRoot()): Promise<SkillBundle> {
  const skills = await getSkillFiles();
  const skillsDir = path.join(root, "skills");

  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  const written: SkillBundle["skills"] = [];
  for (const skill of skills) {
    const skillDir = path.join(skillsDir, skill.installName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill.content);
    written.push({ name: skill.installName, path: skillDir });
  }

  return { root, skillsDir, skills: written };
}
