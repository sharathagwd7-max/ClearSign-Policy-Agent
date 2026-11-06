# ClearSign — AI-Powered Privacy Policy Investigation Agent

ClearSign is a Chrome extension with a Node.js backend that uses Google's Gemini API to help users investigate website privacy policies and understand how their personal data is collected, used, shared, and retained.

## The Problem

Privacy policies are lengthy, difficult to understand, and often contain important details spread across multiple sections. Generic AI summaries can also make claims without sufficient supporting evidence.

ClearSign aims to make privacy policy investigation more transparent by retrieving relevant policy clauses and grounding answers in source evidence.

## Features

- **Policy investigation:** Ask natural-language questions about a website's privacy policy.
- **Policy search:** Search policy documents for relevant clauses.
- **Evidence retrieval:** Retrieve complete clauses using their evidence IDs.
- **Linked policy inspection:** Inspect eligible linked policy documents on the same website.
- **Clause analysis:** Analyse policy language and identify relevant evidence.
- **Opt-out assistance:** Draft opt-out emails without sending them.
- **Citation validation:** Check whether cited evidence IDs were actually retrieved.
- **Tool-call trace:** View the tools used during an investigation.

## Architecture

```text
Chrome Extension
      |
      v
Node.js / Express Backend
      |
      v
Custom Agent Orchestrator
      |
      v
Google Gemini API
      |
      v
Custom Policy Tools
      |
      +-- search_policy
      +-- get_clause_details
      +-- inspect_linked_policy
      +-- analyze_clause
      +-- draft_optout_email
      |
      v
Evidence Retrieval and Citation Validation
      |
      v
Grounded Answer to the Extension
```

## Technology Stack

| Component | Technology |
|---|---|
| Browser extension | JavaScript, HTML |
| Backend | Node.js, Express |
| LLM | Google Gemini API |
| Agent orchestration | Custom tool-calling loop |
| Policy processing | JavaScript |
| Version control | Git and GitHub |

## How the Agent Works

1. The user opens a website and analyses its policy using the ClearSign extension.
2. Policy content is processed and stored in a backend session.
3. The user asks a question through the Policy Agent interface.
4. Gemini determines which policy investigation tools are useful.
5. The backend executes the requested tools and returns their results.
6. Relevant clauses are retrieved for evidence-based answering.
7. Citation validation checks that referenced evidence IDs were retrieved.
8. The agent returns an answer with supporting evidence and limitations.

## Custom Agent Tools

| Tool | Purpose |
|---|---|
| `search_policy` | Search policy clauses using relevant terms |
| `get_clause_details` | Retrieve a complete matched clause |
| `inspect_linked_policy` | Inspect an eligible linked policy document |
| `analyze_clause` | Analyse a policy clause |
| `draft_optout_email` | Generate an opt-out email draft |

The agent uses a custom orchestration loop rather than a prebuilt agent framework.

## Getting Started

### Requirements

- Node.js 20 or newer
- Google Gemini API key
- Google Chrome or Chromium

### 1. Clone the repository

```bash
git clone https://github.com/sharathagwd7-max/ClearSign-Policy-Agent.git
cd ClearSign-Policy-Agent
```

### 2. Configure the backend

```bash
cd backend
npm install
```

Create a `.env` file using `.env.example` as a template.

Configure your Gemini credentials:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=your_supported_gemini_model
PORT=8787
```

Use a Gemini model available to your API account that supports function calling.

Never commit your `.env` file or expose API keys in extension JavaScript.

### 3. Start the backend

```bash
npm start
```

Check the health endpoint:

```text
http://localhost:8787/health
```

### 4. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the repository's `extension` folder.
5. Open a website containing a privacy policy.
6. Analyse the policy.
7. Open the ClearSign Policy Agent interface.
8. Ask a question about the policy.

Keep the backend running while using the agent.

## Current Limitations

- This is a prototype, not a legal advice product.
- Policy retrieval currently uses keyword-based search rather than vector embeddings.
- Session data is stored in memory and is lost when the backend restarts.
- Linked-policy inspection is restricted by URL and network safety checks.
- AI-generated interpretations can contain errors; users should inspect the original policy evidence.
- Citation validation checks evidence retrieval, but does not guarantee that every interpretation is semantically correct.
- Google Safe Browsing functionality requires its own valid configuration.
- The backend currently runs locally and requires further work before production deployment.

## Future Improvements

- Semantic search and vector-based retrieval.
- Improved evidence ranking and coverage.
- More comprehensive contradiction detection.
- Persistent policy-session storage.
- Automated testing and deployment.
- Improved security and production infrastructure.

## Project

**ClearSign — AI-Powered Privacy Policy Investigation Agent**

Built as an independent AI agent project to explore practical applications of LLMs, custom tool calling, evidence retrieval, and browser-based AI workflows.
