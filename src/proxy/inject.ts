/**
 * Injection content builder for the LLM proxy.
 *
 * The proxy has ~10ms of CPU per request on the free plan, and a Claude Code
 * request body can be hundreds of KB. So everything here is bounded: recall is
 * capped, each hit is truncated, skills are listed by name only, and the total
 * block never exceeds `INJECTION_BUDGET_CHARS`.
 */

import type { Env } from "../types.js";
import { recall } from "../memory/recall.js";
import { listSkills } from "../skills/store.js";

/** Marker so humans (and grep) can tell injected text from model-authored text. */
export const INJECTION_MARKER = "<cf-agent-memory>";

const DEFAULT_BUDGET = 4_000;
const MAX_HIT_CHARS = 300;
const MAX_SKILLS = 20;

export interface InjectionConfig {
  budget: number;
  memories: boolean;
  skills: boolean;
}

export function readInjectionConfig(env: Env): InjectionConfig {
  const budget = Number(env.INJECTION_BUDGET_CHARS);
  return {
    budget: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 20_000) : DEFAULT_BUDGET,
    memories: env.INJECT_MEMORIES !== "0",
    skills: env.INJECT_SKILLS !== "0",
  };
}

/**
 * Index of the last user turn that carries actual prose — not a bare
 * tool_result. Tool results are user-role messages but make a poor recall
 * query *and* a poor injection target, so both the query extraction and the
 * injection must agree on this same turn.
 */
function findLastProseUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!message || message.role !== "user") continue;
    if (messageText(message.content).trim()) return i;
  }
  return -1;
}

export function extractLastUserText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";

  const index = findLastProseUserIndex(messages);
  if (index < 0) return "";
  const message = messages[index] as { content?: unknown };
  return messageText(message.content).slice(0, 2_000);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Build the injection block, or `null` when there is nothing worth injecting.
 * Returning null lets the caller skip the body rewrite entirely.
 */
export async function buildInjection(
  env: Env,
  userId: string,
  query: string,
  config: InjectionConfig,
): Promise<string | null> {
  if (!query.trim()) return null;

  const sections: string[] = [];

  if (config.memories) {
    try {
      const result = await recall(env, userId, query, { limit: 5 });
      const lines = result.hits
        .map((hit) => `- ${hit.memory.content.slice(0, MAX_HIT_CHARS).replace(/\s+/g, " ").trim()}`)
        .filter(Boolean);
      if (lines.length > 0) {
        sections.push(`## 长期记忆（自动召回）\n${lines.join("\n")}`);
      }
    } catch {
      // Recall degrades on its own; never let injection break the request.
    }
  }

  if (config.skills) {
    try {
      const skills = await listSkills(env, userId, { limit: MAX_SKILLS });
      const lines = skills.map((skill) =>
        skill.description
          ? `- \`${skill.name}\` (v${skill.version}) — ${skill.description.slice(0, 120)}`
          : `- \`${skill.name}\` (v${skill.version})`,
      );
      if (lines.length > 0) {
        sections.push(
          `## 可用技能（skill_get 可取全文）\n${lines.join("\n")}`,
        );
      }
    } catch {
      // Skill listing is best-effort.
    }
  }

  if (sections.length === 0) return null;

  const header =
    `${INJECTION_MARKER}\n` +
    `以下内容由 cf-agent-memory 自动注入，是历史沉淀的事实与可用技能，回答时请优先遵循：\n\n`;
  const block = header + sections.join("\n\n");

  return block.length > config.budget ? `${block.slice(0, config.budget)}\n…（已截断）` : block;
}

/**
 * Prepend the block to the last prose-bearing user turn — the same turn
 * `extractLastUserText` reads. Returns a new body; the caller's copy is
 * untouched. Only the affected message is replaced, so the rest of the
 * (possibly large) conversation is shared by reference.
 */
export function injectIntoBody<T extends { messages?: unknown }>(body: T, block: string): T {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const next = [...messages];
  const textBlock = { type: "text", text: block };
  const index = findLastProseUserIndex(next);

  if (index < 0) {
    // No user turn at all (shouldn't happen) — append one rather than dropping.
    return { ...body, messages: [...next, { role: "user", content: [textBlock] }] };
  }

  const message = next[index] as { content?: unknown };
  const original = message.content;
  if (typeof original === "string") {
    next[index] = { ...message, content: [textBlock, { type: "text", text: original }] };
  } else if (Array.isArray(original)) {
    next[index] = { ...message, content: [textBlock, ...original] };
  } else {
    next[index] = { ...message, content: [textBlock] };
  }
  return { ...body, messages: next };
}
