# Architecture

Chrome extension (Manifest V3) -> Express `/api/agent/investigate` -> custom orchestrator -> OpenRouter model with tool definitions -> validated tool registry -> policy session/tools -> tool results returned to model -> evidence-grounded final answer -> popup.

The agent has five tools: search_policy, get_clause_details, inspect_linked_policy, analyze_clause and draft_optout_email. The model selects tools dynamically; the backend validates tool names, executes only registered functions and enforces a six-turn cap.

Policy text is sent from the existing local ClearSign analysis record to the backend for each question. The prototype uses a per-request in-memory session and keyword retrieval. It does not persist documents or user history.
