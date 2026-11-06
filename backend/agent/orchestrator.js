'use strict';

const { SYSTEM_PROMPT } = require('./prompts');
const { toolDefinitions, executeTool } = require('./tool-registry');
const { createSession } = require('../services/policy-store');
const { chatCompletion } = require('../services/openrouter');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function auditCitations(answer, session, retrievedEvidenceIds) {
  const issues = [];
  const answerText = typeof answer === 'string' ? answer : '';
  const normalizedAnswer = answerText.toLowerCase();

  const citedIds = [
    ...new Set(
      [...answerText.matchAll(/\bclause_\d+\b/gi)]
        .map(match => match[0].toLowerCase())
    )
  ];

  const sessionClauses = Array.isArray(session.clauses)
    ? session.clauses
    : [];

  const knownClauses = new Map(
    sessionClauses.map(clause => [
      String(clause.id || '').toLowerCase(),
      clause
    ])
  );

  // Check that every cited ID exists and was retrieved in full.
  for (const id of citedIds) {
    if (!knownClauses.has(id)) {
      issues.push(`Unknown evidence ID: ${id}`);
      continue;
    }

    if (!retrievedEvidenceIds.has(id)) {
      issues.push(`Evidence ID was not retrieved in full: ${id}`);
    }
  }

  // Build the set of known source URLs.
  const knownUrls = new Set();

  for (const doc of session.documents || []) {
    const normalized = normalizeUrl(doc.url);

    if (normalized) {
      knownUrls.add(normalized);
    }
  }

  for (const clause of sessionClauses) {
    const normalized = normalizeUrl(
      clause.sourceUrl || clause.source_url
    );

    if (normalized) {
      knownUrls.add(normalized);
    }
  }

  // Validate complete URLs, ignoring visibly truncated URLs.
  const citedUrls = [
    ...new Set(
      [...answerText.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
        .map(match => match[0].replace(/[.,;!?]+$/, ''))
        .filter(url => !url.includes('...'))
        .map(normalizeUrl)
        .filter(Boolean)
    )
  ];

  for (const url of citedUrls) {
    if (!knownUrls.has(url)) {
      issues.push(
        `Source URL does not match a retrieved document: ${url}`
      );
    }
  }

  // Reject empty or generic failure answers.
  const failurePhrases = [
    'the investigation could not produce a final answer',
    'unable to produce a final answer',
    'an unexpected error occurred',
    'something went wrong'
  ];

  if (
    !answerText.trim() ||
    answerText.trim().length < 100 ||
    failurePhrases.some(phrase => normalizedAnswer.includes(phrase))
  ) {
    issues.push(
      'The final answer is empty, too short, or contains a generic failure response.'
    );
  }

  // If evidence was retrieved, at least one ID must be cited.
  if (retrievedEvidenceIds.size > 0 && citedIds.length === 0) {
    issues.push(
      'Evidence was retrieved, but the answer contains no ClearSign evidence IDs.'
    );
  }

  if (
    retrievedEvidenceIds.size > 0 &&
    !citedIds.some(id => retrievedEvidenceIds.has(id))
  ) {
    issues.push(
      'The answer does not cite any evidence retrieved in full.'
    );
  }

  // Flag policy claims made without fully retrieved evidence.
  const makesPolicyClaims =
    /\b(policy states|the policy says|spotify shares|the company shares|the company sells|the policy confirms|the policy allows|the policy requires)\b/i.test(answerText);

  if (makesPolicyClaims && retrievedEvidenceIds.size === 0) {
    issues.push(
      'The answer makes policy claims, but no evidence was retrieved in full.'
    );
  }

  return {
    valid: issues.length === 0,
    citedEvidenceIds: citedIds,
    retrievedEvidenceIds: [...retrievedEvidenceIds],
    issues
  };
}

async function runAgent(input) {
  const session = createSession(input);

  const trace = [];
  const toolsUsed = new Set();
  const executedCalls = new Map();
  const retrievedEvidenceIds = new Set();
  const candidateClauses = new Map();

  let toolCallCount = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let searchCallCount = 0;
  let forceFinal = false;
  let automaticRetrievalCompleted = false;

  const maxTurns = 8;
  const maxToolCalls = 7;
  const maxSearchCalls = 3;
  const maxEvidenceClauses = 4;

  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: `Website: ${input.sourceUrl || input.domain || 'unknown'}

Available documents:
${session.documents.map(doc =>
  `${doc.source} — ${doc.url || 'URL unavailable'}`
).join('\n')}

Question: ${input.question}

Investigate the available policy documents.
Gather evidence before answering.
Use linked policies when necessary.
Do not repeat searches that have already produced the needed evidence.
Prioritize retrieving full clause details before producing your final answer.`
    }
  ];

  function getStatus(audit) {
    if (toolCallCount === 0 || successfulToolCalls === 0) {
      return 'failed';
    }

    if (failedToolCalls > 0 || (audit && !audit.valid)) {
      return 'partial';
    }

    return 'completed';
  }

  function buildResult(answer, audit) {
    return {
      status: getStatus(audit),
      answer,
      trace,
      toolsUsed: [...toolsUsed],
      steps: toolCallCount,
      successfulToolCalls,
      failedToolCalls,
      documentCount: session.documents.length,
      clauseCount: session.clauses.length,
      duplicateClausesRemoved: session.duplicateClausesRemoved || 0,
      citationAudit: audit
    };
  }

  function finalizeAnswer(rawAnswer) {
    const audit = auditCitations(
      rawAnswer,
      session,
      retrievedEvidenceIds
    );

    let answer = rawAnswer;

    if (!audit.valid) {
      const warning = [
        '',
        '',
        'ClearSign citation validation warning:',
        'The answer did not pass all evidence checks.',
        ...audit.issues.map(issue => `- ${issue}`),
        'Do not treat unverified claims or citations as established facts.'
      ].join('\n');

      answer += warning;

      trace.push(
        `CITATION AUDIT: ${audit.issues.length} issue(s) detected`
      );
    } else {
      trace.push('CITATION AUDIT: Passed');
    }

    return buildResult(answer, audit);
  }
    // Collect candidate clauses returned by policy searches.
  function collectSearchCandidates(result) {
    if (!Array.isArray(result?.results)) {
      return;
    }

    for (const item of result.results) {
      const id = String(item.id || '').trim().toLowerCase();

      if (!/^clause_\d+$/.test(id)) {
        continue;
      }

      const existing = candidateClauses.get(id);
      const score = Number(item.relevanceScore) || 0;

      if (!existing || score > existing.relevanceScore) {
        candidateClauses.set(id, {
          id,
          relevanceScore: score,
          source: item.source || null,
          sourceUrl: item.sourceUrl || null
        });
      }
    }

    trace.push(
      `CANDIDATES: ${candidateClauses.size} unique clause(s) collected`
    );
  }

  // Automatically retrieve the highest-ranked candidate clauses.
  async function retrieveCandidateEvidence() {
    if (automaticRetrievalCompleted) {
      return;
    }

    automaticRetrievalCompleted = true;

    const candidates = [...candidateClauses.values()]
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    let retrievedThisPhase = 0;

    for (const candidate of candidates) {
      if (retrievedEvidenceIds.size >= maxEvidenceClauses) {
        break;
      }

      if (toolCallCount >= maxToolCalls) {
        trace.push(
          'AUTO RETRIEVAL: Tool-call budget exhausted'
        );
        break;
      }

      if (retrievedEvidenceIds.has(candidate.id)) {
        continue;
      }

      const args = {
        clause_id: candidate.id
      };

      const fingerprint =
        `get_clause_details:${stableStringify(args)}`;

      if (executedCalls.has(fingerprint)) {
        continue;
      }

      toolCallCount++;
      toolsUsed.add('get_clause_details');

      let result;

      try {
        result = await executeTool(
          'get_clause_details',
          args,
          session
        );

        if (!result || typeof result !== 'object') {
          result = {
            status: 'failed',
            error: 'Evidence retrieval returned an invalid result.'
          };
        }
      } catch (error) {
        result = {
          status: 'failed',
          error: error.message || 'Evidence retrieval failed.'
        };
      }

      executedCalls.set(fingerprint, result);

      const returnedId = String(
        result.clause?.id || ''
      ).toLowerCase();

      // Verify that the returned clause matches the requested ID.
      if (
        result.status === 'success' &&
        returnedId === candidate.id
      ) {
        retrievedEvidenceIds.add(candidate.id);
        successfulToolCalls++;
        retrievedThisPhase++;

        trace.push(
          `AUTO get_clause_details: SUCCESS — Retrieved ${candidate.id}`
        );

        // Supply the full retrieved evidence to the final model call.
        messages.push({
          role: 'system',
          content: `ClearSign automatically retrieved this complete policy evidence.

Use this evidence when answering the user's question.
You may cite its Evidence ID only if it appears in the allowed evidence list.

${JSON.stringify(result)}`
        });
      } else {
        failedToolCalls++;

        trace.push(
          `AUTO get_clause_details: FAILED — ${candidate.id}: ${result.error || 'Returned evidence did not match the requested ID.'}`
        );
      }
    }

    trace.push(
      `AUTO RETRIEVAL COMPLETE: ${retrievedThisPhase} additional clause(s) retrieved`
    );
  }

  async function requestFinalAnswer() {
    // Always retrieve available candidate clauses before answering.
    await retrieveCandidateEvidence();

    const allowedEvidenceIds = [...retrievedEvidenceIds];

    messages.push({
      role: 'system',
      content: `You must now produce your final answer.

Do not call any more tools.

Use only evidence retrieved in full through get_clause_details.

THE ONLY EVIDENCE IDs YOU MAY CITE:
${allowedEvidenceIds.length
  ? allowedEvidenceIds.map(id => `- ${id}`).join('\n')
  : 'NONE'}

STRICT CITATION RULES:
- Never cite an ID merely because it appeared in search_policy results.
- Never cite an ID outside the allowed list above.
- If the allowed list is empty, do not invent or cite evidence IDs.
- If relevant evidence appeared in search results but was not retrieved in full, say it could not be verified.
- Do not make factual policy claims based on unretrieved clauses.
- Do not invent quotations, URLs, or policy wording.

ANSWER REQUIREMENTS:
- Clearly answer the user's question.
- Separate explicit policy statements from interpretation.
- Explain what is not established by the retrieved evidence.
- Use exact quotations only when supported by retrieved evidence.
- Identify the source document.
- Do not confuse generated ClearSign evidence IDs with original policy clause numbers.
- If the retrieved evidence is insufficient, explicitly state the limitation.
- If no evidence was retrieved, explain that the investigation could not verify the answer.

Cite IDs exactly in this format:
Evidence ID: clause_123

If the evidence does not establish an answer, say:
"Not established by the available evidence."`
    });

    const response = await chatCompletion(
      messages,
      [],
      { forceFinal: true }
    );

    const message = response.choices?.[0]?.message;

    return typeof message?.content === 'string' &&
      message.content.trim()
      ? message.content.trim()
      : 'The investigation could not produce a final answer from the available evidence.';
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (forceFinal || toolCallCount >= maxToolCalls) {
      const answer = await requestFinalAnswer();
      return finalizeAnswer(answer);
    }

    const response = await chatCompletion(
      messages,
      toolDefinitions
    );

    const message = response.choices?.[0]?.message;

    if (!message) {
      throw new Error(
        'The model returned an empty response. Check model availability and tool-calling support.'
      );
    }

    messages.push(message);

    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];

    if (calls.length) {
      for (const call of calls) {
        const name = call.function?.name;

        let args;

        try {
          args = JSON.parse(
            call.function?.arguments || '{}'
          );
        } catch {
          args = {};
        }

        if (toolCallCount >= maxToolCalls) {
          forceFinal = true;

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              status: 'failed',
              error: 'Tool-call limit reached. Use collected search results and retrieved evidence.'
            })
          });

          continue;
        }

        if (!name) {
          failedToolCalls++;

          trace.push('UNKNOWN TOOL: Missing tool name');

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              status: 'failed',
              error: 'Missing tool name.'
            })
          });

          continue;
        }

        const fingerprint =
          `${name}:${stableStringify(args)}`;

        if (executedCalls.has(fingerprint)) {
          trace.push(`SKIPPED: Repeated ${name} call`);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              status: 'skipped',
              error: 'This exact tool call has already been executed. Use its earlier result.'
            })
          });

          continue;
        }

        // Do not allow more than three policy searches.
        if (
          name === 'search_policy' &&
          searchCallCount >= maxSearchCalls
        ) {
          trace.push(
            'SEARCH LIMIT: Maximum policy searches reached'
          );

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              status: 'failed',
              error: 'Search limit reached. Do not search again. The application will automatically retrieve the most relevant clauses from the search results.'
            })
          });

          forceFinal = true;
          continue;
        }

        if (name === 'search_policy') {
          searchCallCount++;
        }

        toolCallCount++;
        toolsUsed.add(name);

        let result;

        try {
          result = await executeTool(name, args, session);

          if (!result || typeof result !== 'object') {
            result = {
              status: 'failed',
              error: 'Tool returned an invalid result.'
            };
          }
        } catch (error) {
          result = {
            status: 'failed',
            error: error.message || 'Unknown tool execution error.'
          };
        }

        const failed = result.status === 'failed';
        const notFound = result.status === 'not_found';

        if (failed) {
          failedToolCalls++;
        } else {
          successfulToolCalls++;
        }

        // Collect candidate clauses from successful searches.
        if (
          name === 'search_policy' &&
          result.status === 'success'
        ) {
          collectSearchCandidates(result);
        }

        // Record manually retrieved clauses only when the returned
        // evidence ID matches the requested clause ID.
        if (
          name === 'get_clause_details' &&
          result.status === 'success' &&
          typeof args.clause_id === 'string'
        ) {
          const requestedId = args.clause_id.toLowerCase();
          const returnedId = String(
            result.clause?.id || ''
          ).toLowerCase();

          if (returnedId === requestedId) {
            retrievedEvidenceIds.add(requestedId);
          } else {
            failedToolCalls++;
            trace.push(
              `EVIDENCE VALIDATION FAILED: Requested ${requestedId}, received ${returnedId || 'no ID'}`
            );
          }
        }

        executedCalls.set(fingerprint, result);

        const detail =
          result.summary ||
          result.error ||
          result.status ||
          'completed';

        trace.push(
          `${name}: ${failed ? 'FAILED' : notFound ? 'NOT FOUND' : 'SUCCESS'} — ${String(detail).slice(0, 300)}`
        );

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 12000)
        });
      }

      if (forceFinal || toolCallCount >= maxToolCalls) {
        const answer = await requestFinalAnswer();
        return finalizeAnswer(answer);
      }

      continue;
    }
        // If Gemini tries to answer without using tools, first retrieve
    // candidate evidence automatically and then request a grounded answer.
    if (
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      const answer = await requestFinalAnswer();
      return finalizeAnswer(answer);
    }

    throw new Error(
      'Model returned neither a tool call nor a final answer.'
    );
  }

  const answer = await requestFinalAnswer();

  return finalizeAnswer(answer);
}

module.exports = { runAgent };