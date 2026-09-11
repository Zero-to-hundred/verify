/**
 * Parsing Claude Code's `--output-format stream-json` transcript.
 *
 * We measure what the agent DID, never what it claimed. The final `accept`
 * verdict in the report always comes from running the acceptance spec
 * ourselves afterwards; everything here is only for understanding the run.
 */
export interface StreamStats {
  /** Turns the agent took, from the final result message. */
  turns: number;
  /** Tool calls by tool name, e.g. `{ "mcp__Jetpack__verify": 4, "Edit": 11 }`. */
  toolCalls: Record<string, number>;
  /** Every verify/accept attempt in order, with whether it came back green. */
  attempts: Array<{ kind: "verify" | "accept"; ok: boolean | null; via: string }>;
  /** The agent's own final message, for the record. */
  finalText: string;
  costUsd: number | null;
  /** Set when the CLI itself reported an error rather than a completed run. */
  error: string | null;
}

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface TextBlock {
  type: "text";
  text?: string;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
type Block = ToolUseBlock | TextBlock | ToolResultBlock | { type: string };

interface StreamMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  message?: { content?: Block[] };
}

/** What a tool call was trying to prove, if anything. */
function classify(
  name: string,
  input: Record<string, unknown> | undefined,
): {
  kind: "verify" | "accept";
  via: string;
} | null {
  if (name === "mcp__Jetpack__verify") {
    const feature = typeof input?.feature === "string" ? input.feature : undefined;
    return feature
      ? { kind: "accept", via: `verify { feature: "${feature}" }` }
      : { kind: "verify", via: "verify {}" };
  }
  if (name === "Bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    if (/\bpnpm\s+(run\s+)?accept\b/.test(command)) return { kind: "accept", via: command.trim() };
    if (/\bpnpm\s+(run\s+)?verify\b/.test(command)) return { kind: "verify", via: command.trim() };
  }
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as TextBlock).text) : ""))
      .join("\n");
  }
  return "";
}

export function parseStream(jsonl: string): StreamStats {
  const stats: StreamStats = {
    turns: 0,
    toolCalls: {},
    attempts: [],
    finalText: "",
    costUsd: null,
    error: null,
  };
  /** tool_use_id → the attempt it belongs to, so the result can score it. */
  const pending = new Map<string, number>();

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let message: StreamMessage;
    try {
      message = JSON.parse(trimmed) as StreamMessage;
    } catch {
      continue;
    }

    for (const block of message.message?.content ?? []) {
      if (block.type === "tool_use") {
        const use = block as ToolUseBlock;
        const name = use.name ?? "unknown";
        stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
        const attempt = classify(name, use.input);
        if (attempt) {
          stats.attempts.push({ ...attempt, ok: null });
          if (use.id) pending.set(use.id, stats.attempts.length - 1);
        }
      } else if (block.type === "tool_result") {
        const result = block as ToolResultBlock;
        const index = result.tool_use_id ? pending.get(result.tool_use_id) : undefined;
        const attempt = index === undefined ? undefined : stats.attempts[index];
        if (attempt) {
          const text = resultText(result.content);
          attempt.ok =
            result.is_error === true
              ? false
              : /"ok":\s*true|✓ accept|grade --strict passed|feature\(s\) green/.test(text)
                ? true
                : /"ok":\s*false|✗ accept|failed|error/i.test(text)
                  ? false
                  : null;
        }
      }
    }

    if (message.type === "result") {
      stats.turns = message.num_turns ?? stats.turns;
      stats.costUsd = message.total_cost_usd ?? null;
      stats.finalText = message.result ?? "";
      if (message.is_error || (message.subtype && message.subtype !== "success")) {
        stats.error = message.subtype ?? "the CLI reported an error";
      }
    }
  }
  return stats;
}
