import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PREAMBLE = "agent-skills loaded. Use the skill discovery flowchart to find the right skill for your task.";

export default function agentSkillsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "using-agent-skills", "SKILL.md");
      const body = await readFile(skillPath, "utf8");
      pi.sendMessage({ customType: "agent-skills", content: `${PREAMBLE}\n\n${body}`, display: true }, { deliverAs: "nextTurn", triggerTurn: false });
    } catch (error) {
      pi.logger.warn(`agent-skills: unable to load using-agent-skills: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
