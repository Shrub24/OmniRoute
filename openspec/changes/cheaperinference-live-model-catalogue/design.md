## Context

CheaperInference static text models encode `targetFormat` for a mixture of Chat Completions and Responses upstream APIs. The existing discovery pipeline persists richer per-connection metadata and runtime resolution already prioritizes custom and synced metadata over the registry. The provider's authenticated `/v1/models?type=text` API supplies a per-model `endpoint` field and capabilities.

## Goals / Non-Goals

**Goals:**
- Reuse the established custom provider discovery parser and synced-model persistence path.
- Map only the provider-declared endpoint to the existing runtime target-format representation.
- Let the executor consume resolved runtime metadata for live-only models without changing other providers.

**Non-Goals:**
- Import image models, synchronize prices, infer token limits, or generalize provider discovery.
- Change global Responses `store` handling.

## Decisions

### Use a CheaperInference discovery parser

Add a provider-local parser to the existing provider discovery configuration rather than adding the provider to the generic named OpenAI-style set. This permits filtering `type=text`, handles the provider's response envelope, maps its explicit `endpoint` field to target format, and preserves capabilities without model-name heuristics.

The alternative—generic model-ID discovery plus static tags—cannot route a newly introduced Responses model.

### Pass resolved endpoint format through existing execution context

Expose the resolved CheaperInference target format through the established provider-specific execution context and have the provider executor prefer that transient value before the registry fallback. The static registry remains the offline fallback and continues to route known models without synced metadata.

The alternative—adding a separate CheaperInference runtime catalogue—is redundant with the existing synced metadata precedence and persistence mechanism.

### Preserve endpoint-specific request behavior in the executor

Continue injecting `store: false` only when the resolved target is Responses. This is localized to the provider executor because it reflects CheaperInference's stateless upstream contract.

## Risks / Trade-offs

- [The upstream response wrapper changes] → normalize both documented envelope and compatible OpenAI-style list forms, with static fallback on a failed discovery request.
- [A live model lacks a recognized endpoint] → retain its default Chat-compatible route rather than infer protocol from its name.
- [A newly discovered model lacks static pricing] → leave pricing unchanged; this change must not create pricing entries or synchronization behavior.

## Migration Plan

The change is additive. Existing connections fall back to the static registry until their next discovery/sync request; disabling or failing live discovery retains the current static catalogue behavior. Rollback removes the provider-specific discovery and runtime metadata handling, returning to the static snapshot.
