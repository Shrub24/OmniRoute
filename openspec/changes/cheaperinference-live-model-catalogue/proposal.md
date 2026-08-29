## Why

CheaperInference currently treats a July 2026 static model snapshot as its primary text catalogue. The provider's volatile live catalogue includes model-level endpoint metadata, so static-only discovery prevents newly available models from being routed correctly.

## What Changes

- Fetch the authenticated CheaperInference text-model catalogue through the existing provider discovery and sync paths.
- Preserve each discovered model's upstream endpoint and capabilities as synced metadata so runtime resolution selects Chat Completions or Responses correctly.
- Preserve static registry models as the existing offline/live-fetch-failure fallback.
- Preserve the CheaperInference Responses executor requirement to send `store: false`.
- Exclude live pricing synchronization and changes to pricing storage.

## Capabilities

### New Capabilities
- `provider-model-discovery/cheaperinference-live-catalogue`: Discover and persist CheaperInference text models with endpoint-aware runtime metadata.

### Modified Capabilities
- None.

## Impact

- Provider model discovery and model-sync configuration for CheaperInference.
- Runtime execution metadata resolution used by the CheaperInference executor.
- Focused provider discovery and executor regression tests.
