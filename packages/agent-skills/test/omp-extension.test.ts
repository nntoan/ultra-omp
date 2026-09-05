import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "../extensions/index";

type Handler = (event: unknown, context: unknown) => Promise<void>;
type Recorder = {
  on: (event: string, handler: Handler) => void;
  sendMessage: (message: unknown, options: unknown) => void;
  logger: { warn: (message: string) => void };
};

test("session start queues the complete discovery skill without triggering a turn", async () => {
  const handlers: Record<string, Handler> = {};
  const messages: Array<{ message: { content: string }; options: unknown }> = [];
  const recorder: Recorder = {
    on: (event, handler) => { handlers[event] = handler; },
    sendMessage: (message, options) => {
      if (typeof message === "object" && message !== null && "content" in message && typeof message.content === "string") {
        messages.push({ message: { content: message.content }, options });
      }
    },
    logger: { warn: () => {} },
  };
  extension(recorder as unknown as ExtensionAPI);
  expect(Object.keys(handlers)).toHaveLength(1);
  await handlers.session_start({}, {});
  expect(messages).toHaveLength(1);
  const body = await readFile(join(import.meta.dir, "..", "skills/using-agent-skills/SKILL.md"), "utf8");
  expect(messages[0].message.content).toContain(body);
  expect(messages[0].options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
});
