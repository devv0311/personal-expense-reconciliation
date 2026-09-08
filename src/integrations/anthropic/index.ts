/**
 * `src/integrations/anthropic` — a concrete model provider behind `ai.ModelTransport`.
 *
 * The only place in this repository that knows a provider's URL or wire format. Everything
 * upstream of it speaks `ModelRequest`/`unknown` (`docs/architecture/ai-boundary.md`), so
 * swapping providers is one file, and no financial rule moves.
 */

export * from './transport.js';
