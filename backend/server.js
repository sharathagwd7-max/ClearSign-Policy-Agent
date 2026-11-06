require('dotenv').config();
const express = require('express');
const cors = require('cors');
const agentRoutes = require('./routes/agent.routes');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ClearSign Policy Agent' }));
app.use('/api/agent', agentRoutes);
app.use((err, _req, res, _next) => {
  console.error('[server]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`ClearSign agent backend listening at http://localhost:${port}`));
