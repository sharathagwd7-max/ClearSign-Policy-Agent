
const crypto = require('crypto');

function splitIntoClauses(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => part.length >= 35);
}

// Normalize text only for duplicate comparison.
// The original clause text is preserved for evidence and citations.
function normalizeClause(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function createSession(input = {}) {
  const supplied = Array.isArray(input.documents)
    ? input.documents
    : [];

  const documents = [];

  if (supplied.length) {
    for (const item of supplied.slice(0, 6)) {
      if (
        !item ||
        typeof item.text !== 'string' ||
        item.text.trim().length < 35
      ) {
        continue;
      }

      documents.push({
        id: `document_${documents.length + 1}`,
        source: String(
          item.source || item.label || 'Linked Policy'
        ).slice(0, 120),
        label: String(
          item.label || item.source || 'Policy document'
        ).slice(0, 120),
        url: typeof item.url === 'string'
          ? item.url.slice(0, 2048)
          : null,
        text: item.text.slice(0, 50000)
      });
    }
  }

  // Backward compatibility with requests containing only policyText.
  if (!documents.length) {
    const text = String(input.policyText || '').slice(0, 50000);

    documents.push({
      id: 'document_1',
      source: 'Current page policy',
      label: 'Current page',
      url: input.sourceUrl || null,
      text
    });
  }

  const clauses = [];
  let duplicateClausesRemoved = 0;

  for (const document of documents) {
    // Each document gets its own duplicate tracker.
    // Identical clauses in different documents are preserved.
    const seenClauses = new Set();

    for (const clauseText of splitIntoClauses(document.text)) {
      if (clauses.length >= 1200) {
        break;
      }

      const normalized = normalizeClause(clauseText);

      if (!normalized) {
        continue;
      }

      if (seenClauses.has(normalized)) {
        duplicateClausesRemoved++;
        continue;
      }

      seenClauses.add(normalized);

      clauses.push({
        id: `clause_${clauses.length + 1}`,
        text: clauseText,
        source: document.source,
        sourceUrl: document.url,
        documentId: document.id
      });
    }

    if (clauses.length >= 1200) {
      break;
    }
  }

  return {
    id: crypto.randomUUID(),
    sourceUrl: input.sourceUrl || documents[0]?.url || null,
    domain: input.domain || null,
    documents,
    clauses,
    duplicateClausesRemoved
  };
}

module.exports = { createSession };
