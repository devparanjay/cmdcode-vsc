import { createHash } from 'node:crypto';

import { PLAN_TIER_ORDER, type CatalogModel, type PlanTier } from './types.js';

// This module imports no `vscode` (architecture §3.1). It is data plus four
// pure functions, so `test/catalog.test.ts` asserts all 82 entries under a plain
// vitest run with no extension host and no stub.

/**
 * Fallback for a catalog entry whose Context column is "—".
 *
 * Basis: reference/byok.md:141 documents the CLI's default for an undeclared
 * `contextWindow` as "Default: 200K". We adopt 200K literally (200_000,
 * K = 1000), which is also the convention the transcription rules use for every
 * other Context value ("multiply by 1000").
 *
 * Safe direction: under-advertising maxInputTokens can only cause Copilot to
 * truncate a conversation earlier than strictly necessary. It cannot cause a
 * context overflow. Over-advertising could.
 */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/** Advertised maxOutputTokens for every model — the catalog states no per-model output cap. */
export const MAX_OUTPUT_TOKENS = 32_000;

/**
 * 82 entries, EXACT ids, transcribed from the CLI's bundled
 * `reference/models.md` (command-code@1.66.0) in file order, section by section:
 * Open Source, Stealth, Anthropic, OpenAI, Google, Sakana, Meta, xAI.
 *
 * Transcription rules:
 *   - the Id column is copied EXACTLY — never lowercased, trimmed or invented,
 *     because `cmd -m` matches on the segment after the last "/" (verified:
 *     `foo/claude-sonnet-5` and `claude-sonnet-5` resolve to the same model).
 *     19 of the 82 ids therefore carry NO "/" at all — the 9 Anthropic and 10
 *     OpenAI ids are unprefixed in the vendor's own reference table. Anything
 *     else would be an id we invented.
 *   - Context: `200K`→200_000, `256K`→256_000, `262K`→262_000, `400K`→400_000,
 *     `500K`→500_000, `1M`→1_000_000, `1.05M`→1_050_000, `—`→0. `catalog-to-chat`
 *     substitutes DEFAULT_CONTEXT_TOKENS for a 0.
 *   - Efforts: `—`→`[]`, otherwise the comma-separated list as written.
 *   - Min plan: `Go and above`→go (52), `GOAT and above`→goat (8),
 *     `Pro and above`→pro (14), `Max`→max (8).
 *   - The last column is the tooltip blurb, verbatim.
 */
export const MODELS: readonly CatalogModel[] = [
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (latest)',
    contextWindow: 1000000,
    efforts: ['high', 'max'],
    minPlan: 'go',
    blurb: 'hybrid-attention long-context reasoning',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash (latest)',
    contextWindow: 1000000,
    efforts: ['high', 'max'],
    minPlan: 'go',
    blurb: 'fast hybrid-attention reasoning',
  },
  {
    id: 'deepseek/deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision (exp)',
    contextWindow: 1000000,
    efforts: ['high', 'max'],
    minPlan: 'go',
    blurb: 'fast hybrid-attention reasoning with vision',
  },
  {
    id: 'deepseek/deepseek-v4-flash-fast',
    name: 'DeepSeek V4 Flash Fast',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'low-latency V4 Flash deployment',
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'V4.1 hybrid-attention reasoning with vision',
  },
  {
    id: 'moonshotai/Kimi-K3',
    name: 'Kimi K3',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'long-horizon coding & knowledge work with 1M context',
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    name: 'Kimi K2.7 Code',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'improved long-horizon coding with vision',
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code-Highspeed',
    name: 'Kimi K2.7 Code HighSpeed',
    contextWindow: 262000,
    efforts: [],
    minPlan: 'go',
    blurb: 'high-speed long-horizon coding with vision',
  },
  {
    id: 'moonshotai/Kimi-K2.6',
    name: 'Kimi K2.6',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'long-horizon coding with vision',
  },
  {
    id: 'moonshotai/Kimi-K2.5',
    name: 'Kimi K2.5',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'multimodal frontend coding',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    contextWindow: 1050000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'fast, affordable GLM coding with 1M context',
  },
  {
    id: 'z-ai/glm-5.3-flashx',
    name: 'GLM-5.3 FlashX',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'high-speed GLM-5.3 Flash with 1M context',
  },
  {
    id: 'zai-org/GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1000000,
    efforts: ['low', 'high', 'max'],
    minPlan: 'go',
    blurb: 'frontier coding with emergent cyber capabilities',
  },
  {
    id: 'zai-org/GLM-5.2',
    name: 'GLM-5.2',
    contextWindow: 1000000,
    efforts: ['high', 'max'],
    minPlan: 'go',
    blurb: 'powerful coding with 1M context and long-horizon tasks',
  },
  {
    id: 'zai-org/GLM-5.2-Fast',
    name: 'GLM-5.2 Fast',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'high-throughput GLM-5.2 with 1M context',
  },
  {
    id: 'zai-org/GLM-5.1',
    name: 'GLM-5.1',
    contextWindow: 0,
    efforts: [],
    minPlan: 'go',
    blurb: 'long-horizon autonomous coding agent',
  },
  {
    id: 'zai-org/GLM-5',
    name: 'GLM-5',
    contextWindow: 200000,
    efforts: [],
    minPlan: 'go',
    blurb: 'multi-mode thinking & long-range planning',
  },
  {
    id: 'MiniMaxAI/MiniMax-M3',
    name: 'MiniMax M3',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'go',
    blurb: 'frontier coding, agents & native multimodality',
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextWindow: 0,
    efforts: [],
    minPlan: 'go',
    blurb: 'end-to-end software engineering agent',
  },
  {
    id: 'MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax M2.5',
    contextWindow: 200000,
    efforts: [],
    minPlan: 'go',
    blurb: 'cross-platform full-stack agentic dev',
  },
  {
    id: 'xiaomi/mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro',
    contextWindow: 1050000,
    efforts: [],
    minPlan: 'go',
    blurb: 'flagship multimodal agentic coding with 1M context',
  },
  {
    id: 'xiaomi/mimo-v2.6-pro-ultraspeed',
    name: 'MiMo V2.6 Pro UltraSpeed',
    contextWindow: 1050000,
    efforts: [],
    minPlan: 'goat',
    blurb: 'low-latency serving tier of MiMo V2.6 Pro',
  },
  {
    id: 'xiaomi/mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    contextWindow: 1050000,
    efforts: [],
    minPlan: 'go',
    blurb: 'efficient multimodal agentic coding with 1M context',
  },
  {
    id: 'xiaomi/mimo-v2.5-pro',
    name: 'MiMo V2.5 Pro',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'high-capability long-context agentic coding',
  },
  {
    id: 'xiaomi/mimo-v2.5',
    name: 'MiMo V2.5',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'efficient long-context agentic coding',
  },
  {
    id: 'Qwen/Qwen3.8-Omni-Flash',
    name: 'Qwen 3.8 Omni Flash',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'omni-modal understanding & multimedia agentic work',
  },
  {
    id: 'Qwen/Qwen3.8-Max-0902',
    name: 'Qwen 3.8 Max 0902',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'upgraded Qwen 3.8 Max: stronger coding & agentic tool use',
  },
  {
    id: 'Qwen/Qwen3.8-Max',
    name: 'Qwen 3.8 Max',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'autonomous long-horizon coding & professional work',
  },
  {
    id: 'Qwen/Qwen3.8-27B',
    name: 'Qwen 3.8 27B',
    contextWindow: 262000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'compact vision-language coding & agentic work',
  },
  {
    id: 'Qwen/Qwen3.8-Flash',
    name: 'Qwen 3.8 Flash',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'fast low-cost agentic coding & reasoning',
  },
  {
    id: 'Qwen/Qwen3.7-Max',
    name: 'Qwen 3.7 Max',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'frontier coding & long-horizon agent execution',
  },
  {
    id: 'Qwen/Qwen3.7-Plus',
    name: 'Qwen 3.7 Plus',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'agentic coding & reasoning at lower cost',
  },
  {
    id: 'Qwen/Qwen3.7-Flash',
    name: 'Qwen 3.7 Flash',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'fast low-cost agentic coding & reasoning',
  },
  {
    id: 'Qwen/Qwen3.6-Max-Preview',
    name: 'Qwen 3.6 Max Preview',
    contextWindow: 0,
    efforts: [],
    minPlan: 'go',
    blurb: 'vibe coding & efficient agent execution',
  },
  {
    id: 'Qwen/Qwen3.6-Plus',
    name: 'Qwen 3.6 Plus',
    contextWindow: 0,
    efforts: [],
    minPlan: 'go',
    blurb: 'agentic coding & reasoning',
  },
  {
    id: 'meituan/LongCat-2.0',
    name: 'LongCat 2.0',
    contextWindow: 1050000,
    efforts: [],
    minPlan: 'go',
    blurb: 'trillion-parameter agentic coding with 1M context',
  },
  {
    id: 'stepfun/Step-5-Preview',
    name: 'Step 5 Preview',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'go',
    blurb: '600B sparse-MoE agentic coding with 1M context',
  },
  {
    id: 'stepfun/Step-3.7-Flash',
    name: 'Step 3.7 Flash',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'multimodal sparse-MoE reasoning',
  },
  {
    id: 'stepfun/Step-3.5-Flash',
    name: 'Step 3.5 Flash',
    contextWindow: 262000,
    efforts: [],
    minPlan: 'go',
    blurb: 'fast sparse-MoE agentic reasoning',
  },
  {
    id: 'tencent/hy3-paid',
    name: 'Tencent Hy3',
    contextWindow: 262000,
    efforts: [],
    minPlan: 'go',
    blurb: 'sparse-MoE reasoning & agentic tool use',
  },
  {
    id: 'tencent/hy4-preview',
    name: 'Tencent Hy4 Preview',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'go',
    blurb: 'agentic coding & sustained multi-step tool use',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    name: 'Nemotron 3 Ultra',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'open reasoning model for long-horizon autonomous agents',
  },
  {
    id: 'thinkingmachines/inkling',
    name: 'Inkling',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'multimodal MoE reasoning',
  },
  {
    id: 'thinkingmachines/inkling-small',
    name: 'Inkling Small',
    contextWindow: 1000000,
    efforts: [],
    minPlan: 'go',
    blurb: 'lightweight MoE reasoning at lower cost and latency',
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Laguna S 2.1',
    contextWindow: 256000,
    efforts: [],
    minPlan: 'go',
    blurb: 'open-weight agentic coding and long-horizon work',
  },
  {
    id: 'inclusionai/ling-3.0-flash-sante:free',
    name: 'Ling 3.0 Flash Sante',
    contextWindow: 262000,
    efforts: [],
    minPlan: 'go',
    blurb: 'health & medicine tuned lightweight-MoE, still strong on code',
  },
  {
    id: 'stealth/space-bunny-alpha',
    name: 'Space Bunny Alpha',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'go',
    blurb: 'stealth model with 1M context',
  },
  {
    id: 'stealth/pixel-canary',
    name: 'Pixel Canary',
    contextWindow: 262000,
    efforts: ['low', 'medium', 'xhigh'],
    minPlan: 'go',
    blurb: 'stealth coding model for web and mobile apps',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'pro',
    blurb: 'best combo of speed & intelligence (recommended)',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'pro',
    blurb: 'prev Sonnet, still fast & capable',
  },
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'most capable for demanding reasoning & long-horizon agents',
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'prev Fable, still strong for deep reasoning & agents',
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'most intelligent Opus for agents and coding',
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'prev flagship, still strong for agents and coding',
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'older Opus, still strong for agents and coding',
  },
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'older Opus, still strong for agents and coding',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    contextWindow: 200000,
    efforts: [],
    minPlan: 'pro',
    blurb: 'fastest & most compact, great for quick tasks',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'max',
    blurb: 'most capable OpenAI model for demanding reasoning & agents',
  },
  {
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'pro',
    blurb: 'built for complex coding & agentic workflows',
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'go',
    blurb: 'most efficient OpenAI model for focused, high-volume tasks',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'goat',
    blurb: 'frontier model for complex professional work',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'pro',
    blurb: 'balances intelligence and cost',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'go',
    blurb: 'optimized for cost-sensitive workloads',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 400000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'pro',
    blurb: 'latest frontier model for general complex work',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 400000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'pro',
    blurb: 'frontier model for general complex work',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    contextWindow: 400000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'pro',
    blurb: 'frontier coding model',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    contextWindow: 400000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'pro',
    blurb: 'fast, cost-effective model for everyday tasks',
  },
  {
    id: 'google/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'goat',
    blurb: 'newest Gemini Flash, improved core reasoning',
  },
  {
    id: 'google/gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'goat',
    blurb: 'higher-quality coding & agentic workflows, fewer tokens',
  },
  {
    id: 'google/gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'pro',
    blurb: 'previous Gemini Flash, still fast & capable',
  },
  {
    id: 'google/gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'pro',
    blurb: 'Pro-level coding proficiency, parallel agentic execution',
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'pro',
    blurb: 'upgraded agentic capabilities, ideal for subagents',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    contextWindow: 1000000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'pro',
    blurb: 'high-volume workhorse model with implicit caching',
  },
  {
    id: 'sakana/fugu-ultra',
    name: 'Fugu Ultra',
    contextWindow: 1000000,
    efforts: ['high', 'xhigh'],
    minPlan: 'max',
    blurb: 'multi-agent orchestration across frontier models',
  },
  {
    id: 'meta/muse-spark-1.1',
    name: 'Muse Spark 1.1',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'pro',
    blurb: 'agentic performance, tool use, and computer use',
  },
  {
    id: 'meta/muse-spark-1.2',
    name: 'Muse Spark 1.2',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'goat',
    blurb: 'coding-optimized for agentic workflows and large codebases',
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    name: 'Muse Spark 1.2 Contributor',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'go',
    blurb: 'Muse Spark 1.2 at ~95% off',
  },
  {
    id: 'meta/muse-spark-1.3',
    name: 'Muse Spark 1.3',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    minPlan: 'goat',
    blurb: 'multimodal reasoning for long-horizon agentic and coding workflows',
  },
  {
    id: 'meta/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1050000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'go',
    blurb: 'Muse Spark 1.3 at up to 95% off',
  },
  {
    id: 'xai/grok-4.5',
    name: 'Grok 4.5',
    contextWindow: 500000,
    efforts: ['low', 'medium', 'high'],
    minPlan: 'go',
    blurb: 'smartest model for coding, agentic tasks, knowledge work',
  },
  {
    id: 'xai/grok-4.6',
    name: 'Grok 4.6',
    contextWindow: 500000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'goat',
    blurb: 'frontier performance on coding, knowledge work, and STEM',
  },
  {
    id: 'xai/grok-4.7',
    name: 'Grok 4.7',
    contextWindow: 500000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    minPlan: 'goat',
    blurb: 'coding and knowledge work, built for multi-hour tasks',
  },
] as const;

/** Look up by exact catalog id. */
export function findModel(id: string): CatalogModel | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * All models the given plan tier can reach, in catalog order.
 *
 * Tiers are cumulative (reference/plans.md: "every higher plan includes it"),
 * so a model is reachable by its own tier and every tier above it.
 * `modelsForPlan('go')` is the 52 Go-only models; `modelsForPlan('max')` is
 * the whole catalog.
 */
export function modelsForPlan(tier: PlanTier): readonly CatalogModel[] {
  const floor = PLAN_TIER_ORDER.indexOf(tier);
  return MODELS.filter((m) => PLAN_TIER_ORDER.indexOf(m.minPlan) <= floor);
}

/**
 * The stable per-model id (architecture §D2): hash of the workspace path and
 * the catalog id, so a vendor rename cannot orphan an existing chat.
 *
 * Shape: `cmdc-` + the first 12 hex characters of
 * sha256(workspaceFsPath + '\0' + catalogId).
 */
export function chatIdFor(catalogId: string, workspaceFsPath: string): string {
  return 'cmdc-' + hash(`${workspaceFsPath}\0${catalogId}`).slice(0, 12);
}

/**
 * Reverse of chatIdFor. Called on the hot path (architecture §4.9 step 2).
 *
 * A linear scan over 82 ids: 82 sha256 digests of ~100 bytes is well under the
 * 1 ms budget in §6.2, so a reverse Map would be a premature optimization that
 * also adds a build step. Deliberate — do not index this.
 *
 * @returns undefined when `chatId` was not minted for this workspace.
 */
export function findModelByChatId(chatId: string, workspaceFsPath: string): CatalogModel | undefined {
  return MODELS.find((m) => chatIdFor(m.id, workspaceFsPath) === chatId);
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
