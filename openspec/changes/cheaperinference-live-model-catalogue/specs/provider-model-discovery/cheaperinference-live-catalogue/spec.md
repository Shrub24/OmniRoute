## Purpose

Provide a current CheaperInference text-model catalogue whose endpoint metadata remains available when OmniRoute executes a request.

## ADDED Requirements

### Requirement: Discover CheaperInference text models
When a configured CheaperInference connection requests model discovery or synchronization, the system SHALL query its authenticated live text-model catalogue and persist the returned text models as the connection's synced catalogue.

#### Scenario: Live catalogue is available
- **WHEN** the provider returns a valid text-model catalogue
- **THEN** the connection's synced catalogue SHALL contain the discovered text models instead of treating the static registry snapshot as authoritative

#### Scenario: Live catalogue is unavailable
- **WHEN** the live catalogue request fails
- **THEN** the system SHALL retain the existing discovery fallback behavior that exposes static registry models

### Requirement: Preserve execution endpoint metadata
The system SHALL retain a discovered CheaperInference text model's declared upstream endpoint and capabilities in synced model metadata.

#### Scenario: Newly discovered Responses model
- **WHEN** a live-only text model declares the Responses endpoint
- **THEN** a request for that model SHALL use the Responses execution path and include `store: false`

#### Scenario: Newly discovered Chat model
- **WHEN** a live-only text model declares the Chat Completions endpoint
- **THEN** a request for that model SHALL use the Chat Completions execution path

### Requirement: Preserve operator model precedence
The system SHALL preserve existing manually configured/custom model behavior and precedence over synced model metadata.

#### Scenario: Custom model overlaps a synced model
- **WHEN** an operator configures a custom model with the same identifier as a discovered model
- **THEN** runtime metadata resolution SHALL continue to apply the custom model metadata first
