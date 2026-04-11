/**
 * Observer module for the observational memory system.
 *
 * Handles extracting observations from raw conversation messages via a
 * background LLM call. The observer watches the conversation and produces
 * structured, timestamped observations that become the agent's sole
 * memory of past interactions.
 *
 * References:
 *   - observational-memory-architecture.md (Observer System section)
 *   - compaction-strategy.md
 */

import type { CompleteFn } from '../compaction.js';
import type { AgentMessage } from '../../context-manager.js';
import type { ObserverOutput } from './types.js';
import { OBSERVER_SYSTEM_PROMPT } from './constants.js';
import { estimateTokens } from '../../token-estimator.js';

// ---------------------------------------------------------------------------
// Message Formatting
// ---------------------------------------------------------------------------

/**
 * Converts an array of AgentMessages into a formatted string for the
 * observer LLM.
 *
 * Each message is formatted with role and positional timestamp. Messages
 * with content arrays (tool calls/results) receive structured formatting
 * so the observer can extract meaningful takeaways.
 *
 * Messages are grouped by date when date information can be inferred.
 */
export function formatMessagesForObserver(messages: AgentMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const label = `Message ${i + 1}`;
    const roleLabel = msg.role;

    if (typeof msg.content === 'string') {
      lines.push(`**${roleLabel} (${label})**: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const parts = formatContentParts(msg.content);
      if (parts) {
        lines.push(`**${roleLabel} (${label})**:\n${parts}`);
      } else {
        lines.push(`**${roleLabel} (${label})**: [empty]`);
      }
    } else {
      lines.push(`**${roleLabel} (${label})**: [empty]`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Format an array of content parts from a structured message.
 *
 * Handles text, tool_use, and tool_result part types. Other part types
 * are rendered with their type label.
 */
function formatContentParts(
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
  const formatted: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text': {
        if (typeof part.text === 'string' && part.text.length > 0) {
          formatted.push(part.text);
        }
        break;
      }

      case 'tool_use': {
        const toolName = typeof part['name'] === 'string' ? part['name'] : 'unknown';
        const argsSummary = summarizeToolArgs(part['input']);
        formatted.push(`[Tool Call: ${toolName}] ${argsSummary}`);
        break;
      }

      case 'tool_result': {
        const toolUseId = typeof part['tool_use_id'] === 'string'
          ? part['tool_use_id']
          : undefined;
        // Resolve tool name: check for a name field on the part, fall back to tool_use_id reference
        const resultToolName = typeof part['name'] === 'string'
          ? part['name']
          : undefined;

        const header = resultToolName
          ? `[Tool Result: ${resultToolName}]`
          : toolUseId
            ? `[Tool Result (ref: ${toolUseId})]`
            : '[Tool Result]';

        const content = extractToolResultContent(part);
        if (content) {
          formatted.push(`${header}\n${content}`);
        } else {
          formatted.push(header);
        }
        break;
      }

      default: {
        // Unknown part type: include type label and any text
        if (typeof part.text === 'string' && part.text.length > 0) {
          formatted.push(`[${part.type}]: ${part.text}`);
        }
        break;
      }
    }
  }

  return formatted.join('\n');
}

/**
 * Summarize tool call arguments into a brief string.
 *
 * Produces a compact summary of the key arguments without reproducing
 * large values verbatim.
 */
function summarizeToolArgs(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return `{${truncateValue(input, 100)}}`;

  if (typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';

    const parts = entries.slice(0, 5).map(([key, value]) => {
      return `${key}: ${truncateValue(String(value), 80)}`;
    });
    const suffix = entries.length > 5 ? `, ... (+${entries.length - 5} more)` : '';
    return `{${parts.join(', ')}${suffix}}`;
  }

  return String(input);
}

/**
 * Extract text content from a tool_result part.
 */
function extractToolResultContent(
  part: { type: string; text?: string; [key: string]: unknown },
): string {
  // Direct text field
  if (typeof part.text === 'string' && part.text.length > 0) {
    return part.text;
  }

  // Content may be nested in a 'content' field (some tool result formats)
  const nested = part['content'];
  if (typeof nested === 'string' && nested.length > 0) {
    return nested;
  }

  if (Array.isArray(nested)) {
    const textParts = nested
      .filter((p): p is { type: string; text: string } =>
        typeof p === 'object' && p !== null && typeof p.text === 'string',
      )
      .map(p => p.text);
    if (textParts.length > 0) return textParts.join('\n');
  }

  return '';
}

/**
 * Truncate a string value for argument summaries.
 */
function truncateValue(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw LLM output from the observer.
 *
 * Extracts content from `<observations>`, `<current-task>`, and
 * `<suggested-response>` XML blocks. Uses simple string matching
 * (not a DOM parser) and is lenient with malformed output.
 *
 * If no `<observations>` tag is found, the entire output is used as
 * observations (graceful fallback).
 */
export function parseObserverOutput(raw: string): ObserverOutput {
  const observations = extractTagContent(raw, 'observations') ?? raw.trim();
  const rawTask = extractTagContent(raw, 'current-task');
  const rawSuggested = extractTagContent(raw, 'suggested-response');

  const result: ObserverOutput = {
    observations: observations.trim(),
  };

  const trimmedTask = rawTask?.trim();
  if (trimmedTask) {
    result.currentTask = trimmedTask;
  }

  const trimmedSuggested = rawSuggested?.trim();
  if (trimmedSuggested) {
    result.suggestedResponse = trimmedSuggested;
  }

  return result;
}

/**
 * Extract content between XML-style tags.
 *
 * Lenient: handles whitespace around tags, multiline content, and
 * nested content. Returns null if the tag pair is not found.
 */
function extractTagContent(text: string, tagName: string): string | null {
  const openPattern = new RegExp(`<${tagName}>`, 'i');
  const closePattern = new RegExp(`</${tagName}>`, 'i');

  const openMatch = openPattern.exec(text);
  if (!openMatch) return null;

  const startIndex = openMatch.index + openMatch[0].length;
  const closeMatch = closePattern.exec(text.slice(startIndex));

  if (!closeMatch) {
    // Opening tag found but no closing tag: return everything after the opening tag
    return text.slice(startIndex);
  }

  return text.slice(startIndex, startIndex + closeMatch.index);
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

/**
 * Build the full observer system prompt.
 *
 * Starts with `OBSERVER_SYSTEM_PROMPT` from constants and optionally
 * appends consumer-provided custom instructions.
 *
 * @param previousObservations - Previous observations for context (unused in system prompt, kept for signature consistency)
 * @param previousObserverTokens - Token budget for previous observations (unused in system prompt)
 * @param customInstruction - Optional consumer-provided instruction to append
 * @returns The complete system prompt string
 */
export function buildObserverPrompt(
  previousObservations: string | null,
  previousObserverTokens: number,
  customInstruction?: string,
): string {
  let prompt = OBSERVER_SYSTEM_PROMPT;

  if (customInstruction) {
    prompt += `\n\n## Additional Instructions\n\n${customInstruction}`;
  }

  return prompt;
}

/**
 * Build the message array to send to the observer LLM.
 *
 * Constructs a sequence of user messages:
 * 1. (Optional) Previous observations for deduplication context
 * 2. The formatted message history
 * 3. A task instruction to extract observations
 *
 * @param messages - The conversation messages to observe
 * @param previousObservations - Previous observations to prevent duplication
 * @param previousObserverTokens - Token budget for the previous observations context
 * @returns Array of message objects for the LLM call
 */
export function buildObserverMessages(
  messages: AgentMessage[],
  previousObservations: string | null,
  previousObserverTokens: number,
): unknown[] {
  const result: Array<{ role: string; content: string }> = [];

  // 1. Previous observations context (if available)
  if (previousObservations && previousObservations.trim().length > 0) {
    const preamble =
      'These are the observations that have already been captured. Do not repeat them. Only add NEW observations from the messages below.\n\n';
    const truncated = tailTruncateToTokenBudget(previousObservations, previousObserverTokens);
    result.push({ role: 'user', content: preamble + truncated });
  }

  // 2. Formatted message history
  const formatted = formatMessagesForObserver(messages);
  result.push({ role: 'user', content: formatted });

  // 3. Task instruction
  result.push({
    role: 'user',
    content: 'Extract observations from the message history above. Follow the output format exactly.',
  });

  return result;
}

/**
 * Tail-truncate a string to fit within a token budget.
 *
 * Keeps the end of the string (most recent observations) and trims
 * from the beginning if the string exceeds the budget.
 */
function tailTruncateToTokenBudget(text: string, tokenBudget: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= tokenBudget) return text;

  // Estimate chars to keep (tokens * 4 chars/token approximation)
  const charsToKeep = tokenBudget * 4;
  if (charsToKeep >= text.length) return text;

  const truncated = text.slice(text.length - charsToKeep);

  // Try to start at a line boundary for cleaner output
  const firstNewline = truncated.indexOf('\n');
  if (firstNewline > 0 && firstNewline < truncated.length * 0.2) {
    return '[...truncated...]\n' + truncated.slice(firstNewline + 1);
  }

  return '[...truncated...]\n' + truncated;
}

// ---------------------------------------------------------------------------
// Degenerate Repetition Detection
// ---------------------------------------------------------------------------

/**
 * Check if the output contains degenerate repetition.
 *
 * Detects a line appearing 5+ times consecutively, which is a known
 * failure mode of LLMs under certain conditions (e.g., high temperature,
 * long context, repetitive input patterns).
 *
 * @param text - The text to check for repetition
 * @returns true if degenerate repetition is detected
 */
export function detectDegenerateRepetition(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 5) return false;

  let consecutiveCount = 1;
  let previousLine = lines[0]!;

  for (let i = 1; i < lines.length; i++) {
    const currentLine = lines[i]!;
    // Skip empty lines for comparison
    if (currentLine.trim() === '' && previousLine.trim() === '') {
      continue;
    }

    if (currentLine === previousLine && currentLine.trim().length > 0) {
      consecutiveCount++;
      if (consecutiveCount >= 5) return true;
    } else {
      consecutiveCount = 1;
      previousLine = currentLine;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the observer LLM call to extract observations from messages.
 *
 * Orchestrates the full observer pipeline:
 * 1. Builds the system prompt (with optional custom instructions)
 * 2. Builds the message array (with previous observations context)
 * 3. Calls the LLM via `complete`
 * 4. Parses the structured output
 * 5. Detects and retries on degenerate repetition (once)
 *
 * @param complete - The LLM completion function
 * @param messages - The conversation messages to observe
 * @param previousObservations - Previous observations for deduplication
 * @param config - Observer configuration
 * @returns Parsed observer output with observations, current task, and suggested response
 */
export async function runObserver(
  complete: CompleteFn,
  messages: AgentMessage[],
  previousObservations: string | null,
  config: {
    previousObserverTokens: number;
    observerInstruction?: string;
  },
): Promise<ObserverOutput> {
  const systemPrompt = buildObserverPrompt(
    previousObservations,
    config.previousObserverTokens,
    config.observerInstruction,
  );

  const observerMessages = buildObserverMessages(
    messages,
    previousObservations,
    config.previousObserverTokens,
  );

  const raw = await complete({ systemPrompt, messages: observerMessages });
  const output = parseObserverOutput(raw);

  // Detect degenerate repetition and retry once
  if (detectDegenerateRepetition(output.observations)) {
    const retryRaw = await complete({ systemPrompt, messages: observerMessages });
    return parseObserverOutput(retryRaw);
  }

  return output;
}
