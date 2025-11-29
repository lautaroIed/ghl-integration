const express = require('express');
const app = express();

app.use(express.json());

const { logWebhook, logError, logSuccess } = require('./utils/logger');
const { shouldProcessWebhook } = require('./utils/filter');
const { syncToGHL } = require('./services/ghl-service');

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Nubimed-GHL Integration Webhook Receiver',
    version: '1.0.0'
  });
});

app.post('/webhook/nubimed', async (req, res) => {
  const timestamp = new Date().toISOString();
  const payload = req.body;
  const headers = req.headers;

  try {
    logWebhook('WEBHOOK_RECEIVED', {
      timestamp,
      headers,
      payload,
      ip: req.ip
    });

    if (!payload || typeof payload !== 'object') {
      logError('INVALID_PAYLOAD', { payload });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid payload structure'
      });
    }

    const shouldProcess = shouldProcessWebhook(payload);

    if (!shouldProcess) {
      logWebhook('WEBHOOK_IGNORED', {
        timestamp,
        reason: 'Filtered by business logic',
        payload
      });

      return res.status(200).json({
        status: 'ignored',
        message: 'Webhook received but ignored based on filtering rules'
      });
    }

    logWebhook('WEBHOOK_PROCESSING', {
      timestamp,
      payload
    });

    const result = await syncToGHL(payload);

    logSuccess('WEBHOOK_PROCESSED', {
      timestamp,
      result,
      payload
    });

    res.status(200).json({
      status: 'success',
      message: 'Webhook processed successfully',
      contactId: result.contactId,
      isNew: result.isNew
    });

  } catch (error) {
    logError('WEBHOOK_ERROR', {
      timestamp,
      error: error.message,
      stack: error.stack,
      payload
    });

    res.status(200).json({
      status: 'error',
      message: 'Webhook received but error occurred',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

app.use((err, req, res, next) => {
  logError('EXPRESS_ERROR', {
    error: err.message,
    stack: err.stack
  });

  res.status(500).json({
    status: 'error',
    message: 'Internal server error'
  });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Webhook receiver running on port ${PORT}`);
  });
}

