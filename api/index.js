const express = require('express');
const app = express();

// Support multiple content types
// JSON parser
app.use(express.json({ 
  limit: '10mb',
  strict: false
}));

// Form-encoded parser (for application/x-www-form-urlencoded)
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb' 
}));

// Raw body parser as fallback
app.use(express.raw({ type: 'application/json', limit: '10mb' }));

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
  let payload = req.body;
  const headers = req.headers;
  const contentType = headers['content-type'] || '';

  try {
    // Handle form-encoded data (application/x-www-form-urlencoded)
    if (contentType.includes('application/x-www-form-urlencoded')) {
      logWebhook('FORM_ENCODED_RECEIVED', {
        formFields: Object.keys(payload),
        contentType,
        samplePayload: JSON.stringify(payload).substring(0, 500)
      });
      
      // Make sends form-encoded with fields like:
      // - data: main data object (may be JSON string or object)
      // - name: event name (separate field)
      
      // If 'data' field exists, parse it
      if (payload.data) {
        if (typeof payload.data === 'string') {
          try {
            // Parse JSON string
            const parsedData = JSON.parse(payload.data);
            // Reconstruct: { name: "...", data: {...} }
            payload = {
              name: payload.name || parsedData.name,
              data: parsedData
            };
          } catch (parseError) {
            // Not JSON, use as-is
            payload = {
              name: payload.name,
              data: payload.data
            };
          }
        } else {
          // Data is already an object
          payload = {
            name: payload.name,
            data: payload.data
          };
        }
      }
      // If no 'data' field, form fields might contain the structure directly
      // In that case, use payload as-is but log it
      else {
        logWebhook('FORM_DATA_NO_DATA_FIELD', {
          payloadKeys: Object.keys(payload),
          payload
        });
      }
    }
    // Handle JSON data
    else if (contentType.includes('application/json')) {
      // Handle cases where body might be a Buffer or string
      if (Buffer.isBuffer(payload)) {
        try {
          payload = JSON.parse(payload.toString());
        } catch (parseError) {
          logError('JSON_PARSE_ERROR', { 
            error: parseError.message,
            rawBody: payload.toString().substring(0, 500)
          });
          return res.status(400).json({
            status: 'error',
            message: 'Invalid JSON format'
          });
        }
      } else if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (parseError) {
          logError('JSON_PARSE_ERROR', { 
            error: parseError.message,
            rawBody: payload.substring(0, 500)
          });
          return res.status(400).json({
            status: 'error',
            message: 'Invalid JSON format'
          });
        }
      }
    }

    logWebhook('WEBHOOK_RECEIVED', {
      timestamp,
      headers,
      payload,
      ip: req.ip
    });

    if (!payload || typeof payload !== 'object') {
      logError('INVALID_PAYLOAD', { payload, payloadType: typeof payload });
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

