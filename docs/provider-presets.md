# Provider Presets

BetterToken uses two kinds of counting modes:

- `estimate`: input + output + reasoning, cache excluded
- `api_billed`: input + output + reasoning + cache read/write

## Source-backed presets

### Claude / Anthropic

Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

- Anthropic documents cached input, cache writes, and output separately.
- Cache reads are billed at a reduced rate, not free.
- BetterToken preset: `estimate` for mixed/subscription-style tracking, `api_billed` for API usage.

### OpenAI / Codex

Source: https://platform.openai.com/docs/pricing

- OpenAI pricing exposes `Input`, `Cached input`, and `Output`.
- Codex pricing uses the same structure.
- BetterToken preset: `api_billed`.

### Kimi / Moonshot

Source: https://platform.moonshot.ai/docs/pricing/chat

- The docs explicitly say chat completion bills both input and output.
- Cached tokens are billed at the input-price cache-hit rate.
- BetterToken preset: `api_billed`.

### GLM

Source: https://docs.z.ai/guides/llm/glm-4.5

- The docs confirm thinking mode and context caching.
- The captured source does not fully pin down cache billing semantics.
- BetterToken preset: `estimate` until we have a more explicit billing source.

### DeepSeek

Source: https://api-docs.deepseek.com/news/news250120

- The docs show cache hit / miss input pricing and output pricing for DeepSeek-R1.
- BetterToken preset: `api_billed`.

### Gemini

Source: Google Cloud Vertex AI pricing

- Vertex AI pricing exposes input, cached input, and output tokens explicitly.
- BetterToken preset: `api_billed`.

### MiniMax / others

- Use `estimate` until we have stable public docs that clearly define cache billing.

### MiniMax

Source: https://platform.minimaxi.com/docs/guides/pricing-paygo

- The pay-as-you-go docs expose input, output, cache read, and cache write for text models.
- BetterToken preset: `api_billed` for API usage.

## Recommended defaults

- Global default: `estimate`
- Provider overrides:
  - Claude: `estimate`
  - OpenAI: `api_billed`
  - Codex: `api_billed`
  - Kimi: `api_billed`
  - DeepSeek: `api_billed`
  - MiniMax: `api_billed`
  - GLM: `estimate`
  - Gemini: `api_billed`

## UI guidance

Prefer labels that describe what the mode does, not a marketing name:

- `Estimate`
- `API billed`
- `Output only`
- `Custom`
