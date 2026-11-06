
'use strict';

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

// --------------------------------------------------
// TEXT PROCESSING
// --------------------------------------------------

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
}

function splitIntoClauses(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(item => item.trim())
    .filter(item => item.length >= 35);
}

function normalizeClause(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyPolicySource(url) {
  const path = `${url.pathname} ${url.search}`.toLowerCase();

  if (/privacy|personal[-_]?data|data[-_]?protection/.test(path)) {
    return 'Privacy Policy';
  }

  if (/cookie|tracking[-_]?policy/.test(path)) {
    return 'Cookie Policy';
  }

  if (/terms|conditions|user[-_]?agreement|service[-_]?agreement/.test(path)) {
    return 'Terms of Service';
  }

  if (/advertis|marketing[-_]?policy/.test(path)) {
    return 'Advertising Policy';
  }

  return 'Linked Policy';
}

// --------------------------------------------------
// SEARCH POLICY
// --------------------------------------------------



function searchPolicy(args, session) {
  const query = String(args.query || '').trim();
  const sourceFilter = String(args.source || '').trim();

  if (!query) {
    return {
      status: 'failed',
      error: 'A search query is required.'
    };
  }

  if (!Array.isArray(session.clauses)) {
    return {
      status: 'failed',
      error: 'Policy clauses are not available in this session.'
    };
  }

  function normalizeWords(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  }

  function normalizeSource(value) {
    return normalizeWords(value).join(' ');
  }

  const queryWords = [...new Set(normalizeWords(query))];

  if (!queryWords.length) {
    return {
      status: 'failed',
      error: 'The search query contains no searchable terms.'
    };
  }

  const availableSources = [
    ...new Set(
      session.clauses.map(clause => clause.source || 'Unknown source')
    )
  ];

  let filteredClauses = session.clauses;
  let sourceFilterWarning = null;

  if (sourceFilter) {
    const normalizedFilter = normalizeSource(sourceFilter);

    filteredClauses = session.clauses.filter(clause => {
      const source = normalizeSource(clause.source);
      return source.includes(normalizedFilter) ||
        normalizedFilter.includes(source);
    });

    // Do not silently return zero searched clauses because
    // the model supplied a source label that does not match.
    if (filteredClauses.length === 0) {
      sourceFilterWarning =
        `Source "${sourceFilter}" did not match any stored source. ` +
        'Search was expanded to all available documents.';

      filteredClauses = session.clauses;
    }
  }

  const synonymGroups = [
    ['advertiser', 'advertisers', 'advertising', 'ads', 'ad'],
    ['share', 'shares', 'sharing', 'shared', 'disclose', 'disclosure'],
    ['listen', 'listening', 'play', 'playing', 'playback'],
    ['history', 'activity', 'usage', 'behaviour', 'behavior'],
    ['sell', 'sells', 'selling', 'sold', 'sale'],
    ['partner', 'partners', 'thirdparty', 'thirdparties'],
    ['collect', 'collects', 'collection', 'gather'],
    ['retain', 'retains', 'retention', 'store', 'stores', 'storage'],
    ['delete', 'deletes', 'deletion', 'remove', 'removal'],
    ['personal', 'personally', 'individual'],
    ['data', 'information', 'details']
  ];

  const expandedWords = new Map();

  for (const word of queryWords) {
    expandedWords.set(word, 3);

    for (const group of synonymGroups) {
      if (group.includes(word)) {
        for (const synonym of group) {
          if (!expandedWords.has(synonym)) {
            expandedWords.set(synonym, 1);
          }
        }
      }
    }
  }

  const results = filteredClauses
    .map(clause => {
      const text = String(clause.text || '')
        .normalize('NFKC')
        .toLowerCase();

      const clauseWords = new Set(normalizeWords(text));

      let score = 0;
      const matchedTerms = [];

      for (const [word, weight] of expandedWords.entries()) {
        if (clauseWords.has(word)) {
          score += weight;
          matchedTerms.push(word);
        }
      }

      const normalizedQuery = query
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      if (
        normalizedQuery.length > 3 &&
        text.includes(normalizedQuery)
      ) {
        score += 5;
      }

      return {
        clause,
        score,
        matchedTerms
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(item => ({
      id: item.clause.id,
      text: item.clause.text,
      source: item.clause.source,
      sourceUrl: item.clause.sourceUrl || null,
      documentId: item.clause.documentId || null,
      relevanceScore: item.score,
      matchedTerms: item.matchedTerms
    }));

  return {
    status: 'success',
    summary: `Found ${results.length} matching clause(s) for "${query}".`,
    query,
    totalMatches: results.length,
    indexedClauseCount: session.clauses.length,
    searchedClauseCount: filteredClauses.length,
    requestedSource: sourceFilter || null,
    sourceFilterWarning,
    availableSources,
    results
  };
}

// --------------------------------------------------
// GET COMPLETE CLAUSE DETAILS
// --------------------------------------------------

function getClauseDetails(args, session) {
  const clauseId = String(args.clause_id || '').trim();

  if (!clauseId) {
    return {
      status: 'failed',
      error: 'A clause ID is required.'
    };
  }

  const clause = session.clauses.find(
    item => item.id === clauseId
  );

  if (!clause) {
    return {
      status: 'not_found',
      error: `Clause ${clauseId} was not found.`
    };
  }

  const document = session.documents.find(
    item => item.id === clause.documentId
  );

  return {
    status: 'success',
    summary: `Retrieved ${clauseId} from ${clause.source}.`,
    clause: {
      id: clause.id,
      text: clause.text,
      source: clause.source,
      sourceUrl: clause.sourceUrl || null,
      documentId: clause.documentId || null
    },
    document: document
      ? {
          id: document.id,
          source: document.source,
          url: document.url
        }
      : null
  };
}

// --------------------------------------------------
// BASIC URL AND NETWORK SAFETY
// --------------------------------------------------

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);

  if (
    parts.length !== 4 ||
    parts.some(part =>
      !Number.isInteger(part) || part < 0 || part > 255
    )
  ) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(address) {
  const ip = address.toLowerCase().split('%')[0];

  if (
    ip === '::1' ||
    ip === '::' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe8') ||
    ip.startsWith('fe9') ||
    ip.startsWith('fea') ||
    ip.startsWith('feb')
  ) {
    return true;
  }

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);

    if (net.isIP(mapped) === 4) {
      return isPrivateIPv4(mapped);
    }
  }

  return false;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);

  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);

  return true;
}

async function validatePublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    throw new Error('Private or local network addresses are not allowed.');
  }

  const directIpVersion = net.isIP(host);

  if (directIpVersion) {
    if (isPrivateAddress(host)) {
      throw new Error('Private IP addresses are not allowed.');
    }

    return;
  }

  const addresses = await dns.lookup(host, {
    all: true,
    verbatim: true
  });

  if (!addresses.length) {
    throw new Error('The website hostname could not be resolved.');
  }

  if (addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('The website resolves to a private or restricted IP address.');
  }
}

function normalizeDomain(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

// --------------------------------------------------
// ADD LINKED DOCUMENT WITH DUPLICATE DETECTION
// --------------------------------------------------

function addLinkedDocument(session, document) {
  const clauses = splitIntoClauses(document.text);
  const seen = new Set();

  // Remove duplicates within this document only.
  const uniqueClauses = [];

  for (const clauseText of clauses) {
    const normalized = normalizeClause(clauseText);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueClauses.push(clauseText);
  }

  if (!uniqueClauses.length) {
    return {
      added: 0,
      duplicatesRemoved: clauses.length
    };
  }

  const documentId = `document_${session.documents.length + 1}`;

  const storedDocument = {
    ...document,
    id: documentId
  };

  const startingNumber = session.clauses.length;

  const newClauses = uniqueClauses.map((clauseText, index) => ({
    id: `clause_${startingNumber + index + 1}`,
    text: clauseText,
    source: storedDocument.source,
    sourceUrl: storedDocument.url,
    documentId
  }));

  session.documents.push(storedDocument);
  session.clauses.push(...newClauses);

  session.duplicateClausesRemoved =
    (session.duplicateClausesRemoved || 0) +
    (clauses.length - uniqueClauses.length);

  return {
    added: newClauses.length,
    duplicatesRemoved: clauses.length - uniqueClauses.length,
    documentId,
    clauses: newClauses
  };
}

// --------------------------------------------------
// INSPECT LINKED POLICY
// --------------------------------------------------

async function inspectLinkedPolicy(args, session) {
  const policyUrl = String(args.policy_url || '').trim();

  if (!policyUrl) {
    return {
      status: 'failed',
      error: 'A policy URL is required.'
    };
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(policyUrl);
  } catch {
    return {
      status: 'failed',
      error: 'The supplied policy URL is invalid.'
    };
  }

  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    return {
      status: 'failed',
      error: 'Only HTTP and HTTPS policy URLs are supported.'
    };
  }

  if (parsedUrl.username || parsedUrl.password) {
    return {
      status: 'failed',
      error: 'URLs containing credentials are not allowed.'
    };
  }

  // URL fragments do not identify separate server-side documents.
  parsedUrl.hash = '';

  const canonicalUrl = parsedUrl.href;

  const originalDomain = normalizeDomain(session.domain);
  const requestedDomain = normalizeDomain(parsedUrl.hostname);

  if (!originalDomain || requestedDomain !== originalDomain) {
    return {
      status: 'failed',
      error: 'Only policy pages hosted on the original website domain are allowed.'
    };
  }

  // Avoid fetching the same document more than once.
  const existingDocument = session.documents.find(document => {
    if (!document.url) return false;

    try {
      const existingUrl = new URL(document.url);
      existingUrl.hash = '';

      return existingUrl.href === canonicalUrl;
    } catch {
      return document.url === canonicalUrl;
    }
  });

  if (existingDocument) {
    return {
      status: 'success',
      summary: 'This policy document has already been inspected.',
      documentId: existingDocument.id,
      source: existingDocument.source,
      url: existingDocument.url,
      clauseCount: session.clauses.filter(
        clause => clause.documentId === existingDocument.id
      ).length,
      alreadyInspected: true
    };
  }

  try {
    await validatePublicHost(parsedUrl.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      10000
    );

    let response;

    try {
      response = await fetch(canonicalUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'User-Agent': 'ClearSign-Policy-Investigation-Agent/1.0',
          'Accept': 'text/html,text/plain,application/xhtml+xml'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        status: 'failed',
        error: `The policy website returned HTTP ${response.status}.`
      };
    }

    const contentType = response.headers.get('content-type') || '';

    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      return {
        status: 'failed',
        error: `Unsupported policy content type: ${contentType || 'unknown'}.`
      };
    }

    const declaredLength = Number(
      response.headers.get('content-length') || 0
    );

    if (declaredLength > 1000000) {
      return {
        status: 'failed',
        error: 'The policy document exceeds the 1 MB size limit.'
      };
    }

    const html = await response.text();

    if (Buffer.byteLength(html, 'utf8') > 1000000) {
      return {
        status: 'failed',
        error: 'The downloaded policy document exceeds the 1 MB size limit.'
      };
    }

    const text = stripHtml(html).slice(0, 50000);

    if (text.length < 100) {
      return {
        status: 'failed',
        error: 'The linked page did not contain enough readable policy text.'
      };
    }

    const sourceName = classifyPolicySource(parsedUrl);

    const added = addLinkedDocument(session, {
      source: sourceName,
      label: sourceName,
      url: canonicalUrl,
      text
    });

    if (!added.added) {
      return {
        status: 'failed',
        error: 'No unique usable policy clauses could be extracted from the linked document.'
      };
    }

    return {
      status: 'success',
      summary: `Successfully extracted ${added.added} unique clauses from ${sourceName}. Removed ${added.duplicatesRemoved} duplicate clause(s).`,
      documentId: added.documentId,
      source: sourceName,
      url: canonicalUrl,
      clauseCount: added.added,
      duplicatesRemoved: added.duplicatesRemoved,
      clauses: added.clauses.slice(0, 5).map(clause => ({
        id: clause.id,
        text: clause.text
      }))
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error.name === 'AbortError'
        ? 'The policy website took too long to respond.'
        : error.message
    };
  }
}

// --------------------------------------------------
// ANALYZE A CLAUSE
// --------------------------------------------------

function analyzeClause(args, session) {
  const clauseId = String(args.clause_id || '').trim();
  const question = String(args.question || '').trim();

  if (!clauseId || !question) {
    return {
      status: 'failed',
      error: 'Both clause_id and question are required.'
    };
  }

  const clause = session.clauses.find(
    item => item.id === clauseId
  );

  if (!clause) {
    return {
      status: 'not_found',
      error: `Clause ${clauseId} was not found.`
    };
  }

  return {
    status: 'success',
    summary: `Prepared ${clauseId} for analysis.`,
    question,
    evidence: {
      clauseId: clause.id,
      text: clause.text,
      source: clause.source,
      sourceUrl: clause.sourceUrl || null
    },
    instruction: 'Interpret only the supplied clause. Do not assume that it establishes anything beyond its actual wording.'
  };
}

// --------------------------------------------------
// DRAFT OPT-OUT OR CANCELLATION EMAIL
// --------------------------------------------------

function draftOptoutEmail(args) {
  const action = String(args.action || '').trim();
  const evidence = String(args.evidence || '').trim();
  const company = String(args.company || 'the company').trim();

  if (!action || !evidence) {
    return {
      status: 'failed',
      error: 'Both action and evidence are required.'
    };
  }

  const email = `Subject: Request regarding ${action}

Dear ${company} Support Team,

I am writing to request ${action} for my account.

According to the policy information available to me:
${evidence}

Please review my request and confirm the applicable process, any conditions, and the effective date.

Please provide written confirmation once the request has been processed.

Regards,
[Your Name]
[Registered Email Address]`;

  return {
    status: 'success',
    summary: 'Email draft prepared. No email has been sent.',
    email
  };
}

// --------------------------------------------------
// EXPORT ALL TOOLS
// --------------------------------------------------

module.exports = {
  searchPolicy,
  getClauseDetails,
  inspectLinkedPolicy,
  analyzeClause,
  draftOptoutEmail
};
