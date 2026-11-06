# ClearSign Policy Investigation Agent

This project packages the user's supplied ClearSign Chrome extension with a Node.js backend that adds a custom LLM tool-calling agent.

## What is included

- `extension/`: supplied ClearSign v14 extension files, with the popup's Ask AI flow connected to the local agent backend.
- `backend/`: Express API, OpenRouter client, custom tool-calling orchestrator, policy session store and five tools.
- `docs/`: implementation and demo notes.

## Important security action before using this ZIP

The uploaded `background.js` contained what looked like real OpenRouter and Google Safe Browsing credentials. They have been removed from the packaged extension. **Revoke/rotate both credentials immediately** in their provider dashboards if they were real. Assume the values in the uploaded source are compromised. Never put API secrets in extension JavaScript or commit `.env`.

## Requirements

- Node.js 20 or newer
- An OpenRouter API key
- A model currently available on OpenRouter that supports OpenAI-compatible tool/function calling
- Google Chrome or Chromium

## Setup: backend

1. Open a terminal in `backend/`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env`.
4. Put your new OpenRouter key in `.env` and choose a tool-calling model:

   ```env
   OPENROUTER_API_KEY=your_new_key
   OPENROUTER_MODEL=openai/gpt-4.1-mini
   PORT=8787
   ```

   Model availability and tool-calling support can change. If this model is unavailable on your OpenRouter account, choose another model whose current provider page explicitly supports tool calling.

5. Start the backend:

   ```bash
   npm start
   ```

6. Check `http://localhost:8787/health`. It should return `{ "ok": true, ... }`.

## Setup: Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the `extension/` folder from this ZIP.
5. Open a Terms & Conditions or Privacy Policy page.
6. Click **Analyze T&C** and wait for the scan to finish.
7. Open the ClearSign popup and choose **Policy Agent**.
8. Ask a question about the current policy.

Keep the backend terminal running while using the Policy Agent. The extension talks to `http://localhost:8787`.

## What the agent can do

1. `search_policy`: keyword-search policy clauses and return matches.
2. `get_clause_details`: retrieve a matched clause and adjacent context.
3. `inspect_linked_policy`: fetch a linked policy on the same website, subject to URL, DNS, content-type, size and timeout checks.
4. `analyze_clause`: prepare source evidence for interpretation by the model.
5. `draft_optout_email`: generate an email draft; it never sends it.

The orchestrator gives the model these tools and lets it choose whether to call one or more. It runs for at most six model turns. The API response includes the tools actually called and a trace.

## Honest limitations

- This is a prototype, not a legal advice product.
- Retrieval is keyword-based, not vector/embedding-based.
- Session storage is in-memory and is discarded when the backend restarts.
- Linked-policy fetching is restricted to the same hostname or its subdomains and rejects redirects. Some legitimate sites may block automated fetching.
- The LLM may make mistakes. Always inspect the quoted source clause.
- Existing risk scoring and Google Safe Browsing functionality remain in the original extension. The exposed Google key was removed; Google Safe Browsing API checks will not run until separately and safely configured. Local domain heuristics still run.
- The original extension's existing AI_CHAT handler is retained for compatibility, but its embedded API key has been removed. The popup's new Policy Agent tab uses the backend instead.

## Troubleshooting

- `Failed to fetch`: ensure backend is running and `/health` works; reload the extension after loading it unpacked.
- `OPENROUTER_API_KEY is not configured`: create `backend/.env` from `.env.example` and add a valid key.
- Tool call errors: choose an OpenRouter model that supports function/tool calling.
- No policy text: run Analyze T&C on a policy page first.

## Suggested demo

Ask: "Does this website automatically renew my subscription, and how can I cancel it?"
Show the agent's tool trace, supporting clause and final answer. Then ask a question whose answer is absent to demonstrate that it admits when evidence is missing.
