# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-03-24

### Added
- **Restrictive HITL Mode**: Added `mode: 'restrictive'` to `ToolConfirmationConfig`. This allows "Security by Default" where all state-mutating HTTP methods (POST, PUT, PATCH, DELETE) require manual approval by default.
- **Message Trimming**: Automatic context management with a default 50-message sliding window in `MessagesState`. This prevents token overflow and performance degradation in long-running threads. Configurable via `maxMessages`.
- **Hierarchical Tool Naming**: Postman tools now include parent folder names (e.g., `Users_List`) to prevent name collisions in large collections.
- **Method-Prefixed Tool Names**: All tools are now explicitly prefixed with their HTTP method (e.g., `get_users`, `post_create_user`) for better semantic clarity for the LLM.
- **New Types**: Exported `HttpMethod` and `ConfirmationMode` types for better developer ergonomics.

### Changed
- **Total Type Safety**: Removed all instances of the `any` type from the codebase. Replaced with strict interfaces like `FluidState` and `StateSnapshot`.
- **Improved Retrieval**: Standardized state retrieval from LangGraph checkpoints to use `FluidState` types.
- **Axios Integration**: Added HTTP method metadata to all generated tools.

### Fixed
- **Stale State Bug**: Fixed a race condition where `getPendingConfirmations` could return stale results immediately after an `invoke()`.
- **Argument Leakage**: Fixed a bug where `BASE_URL` from config was being injected into tool arguments exposed to the LLM.
- **LLM Ghosting**: Added logic to ensure the graph properly halts and awaits instructions after a tool rejection path.
- **Tool Naming Collisions**: Enhanced Postman renaming logic with better sanizitation and collision warnings.
