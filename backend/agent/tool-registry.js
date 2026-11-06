
const {
  searchPolicy,
  getClauseDetails,
  inspectLinkedPolicy,
  analyzeClause,
  draftOptoutEmail
} = require('../tools');

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'search_policy',
      description:
        'Search policy clauses. Use source to restrict searching to a specific document, such as Privacy Policy.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          source: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_clause_details',
      description:
        'Retrieve a complete matched clause by its clause ID.',
      parameters: {
        type: 'object',
        properties: {
          clause_id: { type: 'string' }
        },
        required: ['clause_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_linked_policy',
      description:
        'Fetch and extract a relevant linked policy from the same website.',
      parameters: {
        type: 'object',
        properties: {
          policy_url: { type: 'string' }
        },
        required: ['policy_url'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_clause',
      description:
        'Prepare a clause and question for focused interpretation.',
      parameters: {
        type: 'object',
        properties: {
          clause_id: { type: 'string' },
          question: { type: 'string' }
        },
        required: ['clause_id', 'question'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'draft_optout_email',
      description:
        'Draft, but never send, a cancellation or opt-out email.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          evidence: { type: 'string' },
          company: { type: 'string' }
        },
        required: ['action', 'evidence'],
        additionalProperties: false
      }
    }
  }
];

async function executeTool(name, args, session) {
  switch (name) {
    case 'search_policy':
      return searchPolicy(args, session);

    case 'get_clause_details':
      return getClauseDetails(args, session);

    case 'inspect_linked_policy':
      return inspectLinkedPolicy(args, session);

    case 'analyze_clause':
      return analyzeClause(args, session);

    case 'draft_optout_email':
      return draftOptoutEmail(args);

    default:
      throw new Error(`Tool not allowed: ${name}`);
  }
}

module.exports = {
  toolDefinitions,
  executeTool
};
