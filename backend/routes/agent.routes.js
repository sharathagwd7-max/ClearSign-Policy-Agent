const express = require('express');
const { runAgent } = require('../agent/orchestrator');
const router = express.Router();

router.post('/investigate', async (req, res) => {
  try {
    const body = req.body || {};
    const question = body.question;
    const policyText = typeof body.policyText === 'string' ? body.policyText : '';
    const documents = Array.isArray(body.documents) ? body.documents : [];
    const usableDocuments = documents.filter(item => item && typeof item.text === 'string' && item.text.trim().length >= 35);

    if (typeof question !== 'string' || question.trim().length < 3 || question.length > 600) {
      return res.status(400).json({ error: 'Question must be between 3 and 600 characters.' });
    }
    if (policyText.trim().length < 80 && !usableDocuments.some(item => item.text.trim().length >= 80)) {
      return res.status(400).json({ error: 'Policy text is missing or too short. Analyze a policy page first.' });
    }

    const result = await runAgent({
      question: question.trim(),
      policyText: policyText.slice(0, 50000),
      documents: usableDocuments.slice(0, 6).map(item => ({
        source: String(item.source || item.label || 'Linked Policy').slice(0, 120),
        label: String(item.label || item.source || 'Policy document').slice(0, 120),
        url: typeof item.url === 'string' ? item.url.slice(0, 2048) : '',
        text: item.text.slice(0, 50000)
      })),
      sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl.slice(0, 2048) : '',
      domain: typeof body.domain === 'string' ? body.domain.slice(0, 255) : ''
    });
    res.json(result);
  } catch (error) {
    console.error('[agent]', error.message);
    res.status(502).json({ error: error.message || 'Agent request failed.' });
  }
});

router.post('/draft-email', (req, res) => {
  const { company = 'the company', action = 'cancel my subscription', evidence = '' } = req.body || {};
  res.json({ subject: `Request to ${action}`, body: `Hello ${company} Support,\n\nI would like to ${action}. Please confirm the applicable steps and the effective date in writing.\n\nThe policy information I reviewed states: ${String(evidence).slice(0, 1200)}\n\nPlease confirm once this request has been processed.\n\nRegards` });
});

module.exports = router;
