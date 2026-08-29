## 1. Endpoint-aware live discovery

- [x] 1.1 Add CheaperInference live text-catalogue parsing and resolved runtime endpoint metadata using the existing discovery and execution-context paths; verify a live-only Responses model selects the Responses URL and preserves `store: false`.
  - refs: `specs/provider-model-discovery/cheaperinference-live-catalogue/spec.md`, `design.md`
  - delegate: CoderAgent

## 2. Regression coverage

- [x] 2.1 Add focused tests for live-only Chat and Responses models, discovery failure fallback, and custom-model precedence; verify the affected unit test files pass.
  - refs: `specs/provider-model-discovery/cheaperinference-live-catalogue/spec.md`
  - delegate: TestEngineer

## 3. Scope verification

- [x] 3.1 Review the scoped diff for protocol, pricing, and fallback regressions; verify no live pricing synchronization or global store behavior changed.
  - delegate: CodeReviewer
