import type { ThinkingLevel, Model } from '@earendil-works/pi-ai';

export type OllamaThinking = 'binary' | 'levels' | 'default';

export function ollamaThinkingMap(kind: OllamaThinking): Model<string>['thinkingLevelMap'] {
  const unsupported = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  if (kind === 'levels') return { ...unsupported, low: 'low', medium: 'medium', high: 'high' };
  if (kind === 'binary') return { ...unsupported, off: 'none', low: 'high' };
  return unsupported;
}

export function inferOllamaThinking(family: string, capable: boolean): OllamaThinking {
  if (!capable) return 'default';
  if (/gpt.?oss/i.test(family)) return 'levels';
  if (/qwen3|deepseek/i.test(family)) return 'binary';
  return 'default';
}

export function resolveOllamaThinking(kind: OllamaThinking, effort?: ThinkingLevel | 'off'): boolean | string | undefined {
  if (kind === 'default' || effort === undefined) return undefined;
  if (kind === 'binary') return effort !== 'off';
  if (effort === 'off') throw new Error('This Ollama model cannot disable thinking; choose low, medium, or high');
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh' || effort === 'max') return 'high';
  return effort;
}
