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

const { logWebhook, logError, logSuccess, logWarning } = require('./utils/logger');
const { shouldProcessWebhook } = require('./utils/filter');
const { syncToGHL } = require('./services/ghl-service');
const { 
  createOrUpdateAppointment, 
  getExistingAppointmentId, 
  updateContactAppointmentIds 
} = require('./services/calendar-service');

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
            // Reconstruct payload structure: { name: "...", data: {...} }
            // parsedData should already contain: center, doctor, booking, etc.
            payload = {
              name: payload.name || parsedData.name,
              data: parsedData
            };
            
            logWebhook('FORM_DATA_PARSED', {
              name: payload.name,
              hasBooking: !!parsedData.booking,
              hasPatients: !!(parsedData.booking && parsedData.booking.patients),
              sampleData: JSON.stringify(payload).substring(0, 300)
            });
          } catch (parseError) {
            logError('FORM_DATA_PARSE_ERROR', {
              error: parseError.message,
              dataField: payload.data.substring(0, 200)
            });
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

    // Sync contact to GHL
    const result = await syncToGHL(payload);

    // Handle calendar integration for new/updated bookings
    const eventName = payload.name || '';
    const contactId = payload.contact_id || result.contactId;

    if (contactId && (eventName.includes('booking') || eventName.includes('cita'))) {
      try {
        // Extract Nubimed booking ID
        const data = payload.data || payload;
        const booking = data.booking || payload.appointment || payload;
        const nubimedBookingId = booking.id || data.booking_id || payload.booking_id;

        if (nubimedBookingId) {
          // Try to get existing appointment ID from contact custom fields
          const existingAppointmentId = await getExistingAppointmentId(contactId, nubimedBookingId);

          // Create or update appointment in GHL calendar
          const appointmentResult = await createOrUpdateAppointment(
            payload, 
            contactId, 
            existingAppointmentId
          );

          // Update contact custom fields with appointment IDs
          if (appointmentResult.success && appointmentResult.appointmentId) {
            await updateContactAppointmentIds(
              contactId,
              nubimedBookingId,
              appointmentResult.appointmentId
            );
          }

          logSuccess('CALENDAR_SYNC_SUCCESS', {
            contactId,
            appointmentId: appointmentResult.appointmentId,
            nubimedBookingId
          });
        }
      } catch (calendarError) {
        // Log calendar error but don't fail the webhook
        logError('CALENDAR_SYNC_ERROR', {
          error: calendarError.message,
          stack: calendarError.stack,
          contactId
        });
      }
    }

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

// Endpoint for deleted appointments (cita-eliminada)
app.post('/webhook/nubimed/deleted', async (req, res) => {
  const timestamp = new Date().toISOString();
  let payload = req.body;
  const headers = req.headers;
  const contentType = headers['content-type'] || '';

  try {
    // Handle form-encoded data
    if (contentType.includes('application/x-www-form-urlencoded')) {
      if (payload.data && typeof payload.data === 'string') {
        try {
          payload = {
            name: payload.name || 'cita_eliminada',
            data: JSON.parse(payload.data),
            contact_id: payload.contact_id
          };
        } catch (parseError) {
          payload = {
            name: payload.name || 'cita_eliminada',
            data: payload.data,
            contact_id: payload.contact_id
          };
        }
      } else {
        payload = {
          name: payload.name || 'cita_eliminada',
          data: payload.data,
          contact_id: payload.contact_id
        };
      }
    }

    logWebhook('DELETED_APPOINTMENT_RECEIVED', {
      timestamp,
      payload
    });

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid payload structure'
      });
    }

    const contactId = payload.contact_id;
    const data = payload.data || payload;
    
    // Handle different payload structures for deleted bookings
    // Nubimed may send: deleted_booking_id, booking_id, or booking.id
    const nubimedBookingId = 
      data.deleted_booking_id || 
      data.booking_id || 
      payload.booking_id ||
      payload.deleted_booking_id;

    // Validate required fields
    if (!contactId) {
      logError('MISSING_CONTACT_ID', {
        nubimedBookingId,
        payload,
        message: 'Contact ID is required'
      });
      return res.status(400).json({
        status: 'error',
        message: 'Contact ID is required'
      });
    }

    if (!nubimedBookingId) {
      logError('MISSING_BOOKING_ID', {
        contactId,
        payload,
        message: 'Booking ID is required'
      });
      return res.status(400).json({
        status: 'error',
        message: 'Booking ID is required'
      });
    }

    // Get existing appointment ID from contact custom fields using contact_id
    const { 
      getExistingAppointmentId, 
      deleteAppointment, 
      removeContactAppointmentIds 
    } = require('./services/calendar-service');
    
    const existingAppointmentId = await getExistingAppointmentId(contactId, nubimedBookingId);

    if (existingAppointmentId) {
      // Delete appointment from GHL calendar (only needs eventId, not contact_id)
      await deleteAppointment(existingAppointmentId);
      
      // Remove IDs from contact custom fields using contact_id
      await removeContactAppointmentIds(contactId, nubimedBookingId, existingAppointmentId);
      
      logSuccess('APPOINTMENT_DELETED_SUCCESS', {
        contactId,
        nubimedBookingId,
        appointmentId: existingAppointmentId
      });

      return res.status(200).json({
        status: 'success',
        message: 'Appointment deleted successfully',
        appointmentId: existingAppointmentId
      });
    } else {
      logWarning('APPOINTMENT_NOT_FOUND_FOR_DELETE', {
        contactId,
        nubimedBookingId,
        message: 'Appointment not found in contact custom fields'
      });
      return res.status(200).json({
        status: 'ignored',
        message: 'Appointment not found in GHL calendar'
      });
    }

  } catch (error) {
    logError('DELETE_APPOINTMENT_ERROR', {
      timestamp,
      error: error.message,
      stack: error.stack,
      payload
    });

    res.status(200).json({
      status: 'error',
      message: 'Error processing deleted appointment',
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

