const logger = require('../utils/logger');
const { logError, logSuccess, logWarning } = logger;

const GHL_API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_API_TOKEN = process.env.GHL_API_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_CALENDAR_ID = process.env.GHL_CALENDAR_ID || 'ZRPJchKgGQpwzROdPLuH';
const GHL_ASSIGNED_USER_ID = process.env.GHL_ASSIGNED_USER_ID || 'BXixxlTY2nvR9n5BZUp8';

/**
 * Extract appointment data from Nubimed payload
 */
function extractAppointmentData(payload) {
  const data = payload.data || payload;
  const booking = data.booking || payload.appointment || payload;
  
  // Extract booking ID from Nubimed
  const nubimedBookingId = booking.id || data.booking_id || payload.booking_id || null;
  
  // Extract date/time
  const startAt = booking.start_at || booking.startAt || data.start_at || data.startAt || booking.date || booking.datetime;
  const endAt = booking.end_at || booking.endAt || data.end_at || data.endAt || booking.end_date;
  
  // Extract patient info for appointment title
  let patient = {};
  if (booking && booking.patients && Array.isArray(booking.patients) && booking.patients.length > 0) {
    patient = booking.patients[0];
  } else if (data.patients && Array.isArray(data.patients) && data.patients.length > 0) {
    patient = data.patients[0];
  } else if (booking && booking.patient) {
    patient = booking.patient;
  } else {
    patient = payload.patient || {};
  }
  
  const patientName = patient.name || patient.firstName || '';
  const patientSurname = patient.surname || patient.lastName || '';
  const fullName = `${patientName} ${patientSurname}`.trim() || 'Paciente';
  
  // Extract comment/notes
  const comment = booking.comment || data.comment || booking.notes || data.notes || '';
  
  // Extract doctor info
  const doctor = data.doctor || booking.doctor || {};
  const doctorName = doctor.name || '';
  const doctorSurname = doctor.surname || '';
  const doctorFullName = `${doctorName} ${doctorSurname}`.trim() || '';
  
  return {
    nubimedBookingId,
    startAt,
    endAt,
    patientName: fullName,
    comment,
    doctorName: doctorFullName
  };
}

/**
 * Format date for GHL API (ISO 8601 format)
 */
function formatDateForGHL(date) {
  if (!date) return null;
  
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  
  // Return ISO 8601 format
  return d.toISOString();
}

/**
 * Create or update appointment in GHL calendar
 */
async function createOrUpdateAppointment(nubimedPayload, contactId, existingAppointmentId = null) {
  try {
    if (!GHL_API_TOKEN) {
      throw new Error('GHL_API_TOKEN environment variable is required');
    }

    if (!GHL_LOCATION_ID) {
      throw new Error('GHL_LOCATION_ID environment variable is required');
    }

    if (!contactId) {
      throw new Error('Contact ID is required to create appointment');
    }

    const appointmentData = extractAppointmentData(nubimedPayload);
    
    if (!appointmentData.startAt) {
      throw new Error('Appointment start time is required');
    }

    const startDate = formatDateForGHL(appointmentData.startAt);
    const endDate = formatDateForGHL(appointmentData.endAt) || formatDateForGHL(
      new Date(new Date(appointmentData.startAt).getTime() + 30 * 60 * 1000) // Default 30 min if no end time
    );

    if (!startDate) {
      throw new Error('Invalid appointment date format');
    }

    // Build appointment title
    let title = appointmentData.patientName;
    if (appointmentData.doctorName) {
      title = `${appointmentData.patientName} - ${appointmentData.doctorName}`;
    }

    // Build appointment data for GHL
    // Required fields: locationId, calendarId, contactId, assignedUserId, title, startTime, endTime
    const appointmentPayload = {
      locationId: GHL_LOCATION_ID,
      calendarId: GHL_CALENDAR_ID,
      contactId: contactId,
      assignedUserId: GHL_ASSIGNED_USER_ID,
      title: title,
      startTime: startDate,
      endTime: endDate,
      appointmentStatus: "confirmed",
      ignoreFreeSlotValidation: true  // Ignore slot availability validation
    };
    
    // Optional fields (only add if they have values)
    if (appointmentData.comment && appointmentData.comment.trim()) {
      appointmentPayload.description = appointmentData.comment;
    }

    // Remove undefined fields
    Object.keys(appointmentPayload).forEach(key => {
      if (appointmentPayload[key] === undefined) {
        delete appointmentPayload[key];
      }
    });

    logSuccess('APPOINTMENT_CREATE_ATTEMPT', {
      appointmentPayload,
      nubimedBookingId: appointmentData.nubimedBookingId,
      existingAppointmentId
    });

    let response;
    let result;

    // If we have an existing appointment ID, try to update it
    if (existingAppointmentId) {
      try {
        response = await fetch(`${GHL_API_BASE}/calendars/events/appointments/${existingAppointmentId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${GHL_API_TOKEN}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(appointmentPayload)
        });

        const responseText = await response.text();
        try {
          result = JSON.parse(responseText);
        } catch (e) {
          throw new Error(`Invalid JSON response: ${responseText}`);
        }

        if (response.ok) {
          // Extract appointment ID from response (should be same as existingAppointmentId)
          const updatedAppointmentId = result.appointment?.id || result.id || result.event?.id || existingAppointmentId;
          
          logSuccess('APPOINTMENT_UPDATED', {
            appointmentId: updatedAppointmentId,
            existingAppointmentId: existingAppointmentId,
            nubimedBookingId: appointmentData.nubimedBookingId,
            idChanged: updatedAppointmentId !== existingAppointmentId
          });
          return {
            success: true,
            appointmentId: updatedAppointmentId,
            nubimedBookingId: appointmentData.nubimedBookingId,
            action: 'updated',
            idChanged: updatedAppointmentId !== existingAppointmentId
          };
        } else {
          // If update fails (e.g., appointment doesn't exist), fall through to create
          logWarning('APPOINTMENT_UPDATE_FAILED', {
            status: response.status,
            response: result,
            willTryCreate: true
          });
        }
      } catch (updateError) {
        logWarning('APPOINTMENT_UPDATE_ERROR', {
          error: updateError.message,
          willTryCreate: true
        });
      }
    }

    // Create new appointment (or if update failed)
    response = await fetch(`${GHL_API_BASE}/calendars/events/appointments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(appointmentPayload)
    });

    const responseText = await response.text();
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${responseText}`);
    }

    if (!response.ok) {
      logError('APPOINTMENT_CREATE_ERROR', {
        status: response.status,
        statusText: response.statusText,
        response: result,
        appointmentPayload
      });
      
      throw new Error(`GHL API error (${response.status}): ${result.message || JSON.stringify(result)}`);
    }

    const appointmentId = result.appointment?.id || result.id || result.event?.id;

    logSuccess('APPOINTMENT_CREATED', {
      appointmentId,
      nubimedBookingId: appointmentData.nubimedBookingId
    });

    return {
      success: true,
      appointmentId,
      nubimedBookingId: appointmentData.nubimedBookingId,
      action: existingAppointmentId ? 'updated_via_create' : 'created'
    };

  } catch (error) {
    logError('APPOINTMENT_SYNC_ERROR', {
      error: error.message,
      stack: error.stack,
      payload: nubimedPayload
    });
    throw error;
  }
}

/**
 * Delete appointment from GHL calendar
 */
async function deleteAppointment(appointmentId) {
  try {
    if (!GHL_API_TOKEN) {
      throw new Error('GHL_API_TOKEN environment variable is required');
    }

    if (!appointmentId) {
      throw new Error('Appointment ID is required to delete appointment');
    }

    logSuccess('APPOINTMENT_DELETE_ATTEMPT', {
      appointmentId
    });

    const response = await fetch(`${GHL_API_BASE}/calendars/events/${appointmentId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-07-28'
      }
    });

    if (!response.ok) {
      const responseText = await response.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        result = { message: responseText };
      }

      // If appointment not found, consider it already deleted (success)
      if (response.status === 404) {
        logWarning('APPOINTMENT_NOT_FOUND', {
          appointmentId,
          message: 'Appointment already deleted or not found'
        });
        return {
          success: true,
          appointmentId,
          action: 'already_deleted'
        };
      }

      logError('APPOINTMENT_DELETE_ERROR', {
        status: response.status,
        statusText: response.statusText,
        response: result
      });
      
      throw new Error(`GHL API error (${response.status}): ${result.message || JSON.stringify(result)}`);
    }

    logSuccess('APPOINTMENT_DELETED', {
      appointmentId
    });

    return {
      success: true,
      appointmentId,
      action: 'deleted'
    };

  } catch (error) {
    logError('APPOINTMENT_DELETE_ERROR', {
      error: error.message,
      stack: error.stack,
      appointmentId
    });
    throw error;
  }
}

/**
 * Parse comma-separated IDs string into array
 */
function parseCommaSeparatedIds(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }
  // Handle both comma-separated and JSON formats (for backward compatibility)
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    // Not JSON, treat as comma-separated
  }
  return value.split(',').map(id => id.trim()).filter(id => id.length > 0);
}

/**
 * Format array of IDs as comma-separated string
 */
function formatCommaSeparatedIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return '';
  }
  return ids.filter(id => id && id.trim().length > 0).join(',');
}

/**
 * Get existing appointment ID from contact custom fields
 * Uses comma-separated format, maintains order to match booking IDs
 */
async function getExistingAppointmentId(contactId, nubimedBookingId) {
  try {
    if (!contactId || !nubimedBookingId) {
      return null;
    }

    // Search for contact to get custom fields
    const response = await fetch(
      `${GHL_API_BASE}/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_TOKEN}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (!response.ok) {
      logWarning('CONTACT_FETCH_FAILED', {
        contactId,
        status: response.status
      });
      return null;
    }

    const result = await response.json();
    const contact = result.contact || result;

    // Check custom fields for appointment IDs
    const customFields = contact.customFields || [];
    
    // Look for appointment IDs field
    const appointmentIdsField = customFields.find(field => 
      field.id === 'sDiKLOU2RCLGSGubvImI' || 
      field.fieldKey === 'contact.appointment_ids'
    );

    // Look for booking IDs field
    const bookingIdsField = customFields.find(field => 
      field.id === 'cp4F0qVNGNclyphsr5jk' || 
      field.fieldKey === 'contact.nubimed_booking_id'
    );

    if (appointmentIdsField && bookingIdsField && 
        appointmentIdsField.fieldValue && bookingIdsField.fieldValue) {
      // Parse both fields as comma-separated
      const appointmentIds = parseCommaSeparatedIds(appointmentIdsField.fieldValue);
      const bookingIds = parseCommaSeparatedIds(bookingIdsField.fieldValue);
      
      // Find index of nubimedBookingId in bookingIds array
      const bookingIndex = bookingIds.indexOf(String(nubimedBookingId));
      
      // If found and appointment ID exists at same index, return it
      if (bookingIndex >= 0 && bookingIndex < appointmentIds.length) {
        return appointmentIds[bookingIndex];
      }
    }

    return null;
  } catch (error) {
    logWarning('GET_APPOINTMENT_ID_ERROR', {
      error: error.message,
      contactId,
      nubimedBookingId
    });
    return null;
  }
}

/**
 * Update contact custom fields with appointment IDs
 * Uses comma-separated format, maintains order to match booking IDs with appointment IDs
 */
async function updateContactAppointmentIds(contactId, nubimedBookingId, ghlAppointmentId) {
  try {
    if (!contactId || !nubimedBookingId || !ghlAppointmentId) {
      return;
    }

    // Get current contact data
    const response = await fetch(
      `${GHL_API_BASE}/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_TOKEN}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (!response.ok) {
      logWarning('CONTACT_FETCH_FOR_UPDATE_FAILED', {
        contactId,
        status: response.status
      });
      return;
    }

    const result = await response.json();
    const contact = result.contact || result;

    // Get existing custom fields
    const customFields = contact.customFields || [];
    
    // Find existing appointment IDs field
    const appointmentIdsField = customFields.find(field => 
      field.id === 'sDiKLOU2RCLGSGubvImI' || 
      field.fieldKey === 'contact.appointment_ids'
    );

    // Find existing booking IDs field
    const bookingIdsField = customFields.find(field => 
      field.id === 'cp4F0qVNGNclyphsr5jk' || 
      field.fieldKey === 'contact.nubimed_booking_id'
    );

    // Parse existing IDs as comma-separated arrays
    let appointmentIds = parseCommaSeparatedIds(
      appointmentIdsField?.fieldValue || ''
    );
    let bookingIds = parseCommaSeparatedIds(
      bookingIdsField?.fieldValue || ''
    );

    const nubimedBookingIdStr = String(nubimedBookingId);
    const ghlAppointmentIdStr = String(ghlAppointmentId);

    // Find if this booking ID already exists
    const existingIndex = bookingIds.indexOf(nubimedBookingIdStr);

    if (existingIndex >= 0) {
      // Booking ID already exists - no need to update fields
      // Both booking ID and appointment ID don't change when updating
      logSuccess('BOOKING_ID_EXISTS_SKIP_UPDATE', {
        contactId,
        nubimedBookingId,
        ghlAppointmentId,
        message: 'Booking ID already exists, skipping field update'
      });
      return; // No need to update fields
    }

    // New booking: add both IDs at the end (maintain order)
    bookingIds.push(nubimedBookingIdStr);
    appointmentIds.push(ghlAppointmentIdStr);
    logSuccess('APPOINTMENT_ID_ADDED', {
      contactId,
      nubimedBookingId,
      ghlAppointmentId
    });

    // Format as comma-separated strings
    const appointmentIdsStr = formatCommaSeparatedIds(appointmentIds);
    const bookingIdsStr = formatCommaSeparatedIds(bookingIds);

    // Update contact with new custom field values
    const updatePayload = {
      locationId: GHL_LOCATION_ID,
      customFields: [
        {
          id: 'sDiKLOU2RCLGSGubvImI', // Appointment IDs (comma-separated)
          field_value: appointmentIdsStr
        },
        {
          id: 'cp4F0qVNGNclyphsr5jk', // Nubimed Booking IDs (comma-separated)
          field_value: bookingIdsStr
        }
      ]
    };

    const updateResponse = await fetch(
      `${GHL_API_BASE}/contacts/${contactId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GHL_API_TOKEN}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatePayload)
      }
    );

    if (!updateResponse.ok) {
      const responseText = await updateResponse.text();
      logError('CONTACT_APPOINTMENT_IDS_UPDATE_ERROR', {
        contactId,
        status: updateResponse.status,
        response: responseText
      });
    } else {
      logSuccess('CONTACT_APPOINTMENT_IDS_UPDATED', {
        contactId,
        nubimedBookingId,
        ghlAppointmentId,
        appointmentIds: appointmentIdsStr,
        bookingIds: bookingIdsStr
      });
    }
  } catch (error) {
    logError('UPDATE_APPOINTMENT_IDS_ERROR', {
      error: error.message,
      contactId,
      nubimedBookingId,
      ghlAppointmentId
    });
  }
}

/**
 * Remove appointment IDs from contact custom fields (for deleted appointments)
 */
async function removeContactAppointmentIds(contactId, nubimedBookingId, ghlAppointmentId) {
  try {
    if (!contactId || !nubimedBookingId) {
      return;
    }

    // Get current contact data
    const response = await fetch(
      `${GHL_API_BASE}/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_TOKEN}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (!response.ok) {
      logWarning('CONTACT_FETCH_FOR_DELETE_FAILED', {
        contactId,
        status: response.status
      });
      return;
    }

    const result = await response.json();
    const contact = result.contact || result;

    // Get existing custom fields
    const customFields = contact.customFields || [];
    
    // Find existing appointment IDs field
    const appointmentIdsField = customFields.find(field => 
      field.id === 'sDiKLOU2RCLGSGubvImI' || 
      field.fieldKey === 'contact.appointment_ids'
    );

    // Find existing booking IDs field
    const bookingIdsField = customFields.find(field => 
      field.id === 'cp4F0qVNGNclyphsr5jk' || 
      field.fieldKey === 'contact.nubimed_booking_id'
    );

    // Parse existing IDs as comma-separated arrays
    let appointmentIds = parseCommaSeparatedIds(
      appointmentIdsField?.fieldValue || ''
    );
    let bookingIds = parseCommaSeparatedIds(
      bookingIdsField?.fieldValue || ''
    );

    const nubimedBookingIdStr = String(nubimedBookingId);

    // Find index of booking ID to remove
    const indexToRemove = bookingIds.indexOf(nubimedBookingIdStr);

    if (indexToRemove >= 0) {
      // Remove both IDs at the same index to maintain order
      bookingIds.splice(indexToRemove, 1);
      if (indexToRemove < appointmentIds.length) {
        appointmentIds.splice(indexToRemove, 1);
      }

      // Format as comma-separated strings
      const appointmentIdsStr = formatCommaSeparatedIds(appointmentIds);
      const bookingIdsStr = formatCommaSeparatedIds(bookingIds);

      // Update contact with new custom field values
      const updatePayload = {
        locationId: GHL_LOCATION_ID,
        customFields: [
          {
            id: 'sDiKLOU2RCLGSGubvImI', // Appointment IDs (comma-separated)
            field_value: appointmentIdsStr
          },
          {
            id: 'cp4F0qVNGNclyphsr5jk', // Nubimed Booking IDs (comma-separated)
            field_value: bookingIdsStr
          }
        ]
      };

      const updateResponse = await fetch(
        `${GHL_API_BASE}/contacts/${contactId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${GHL_API_TOKEN}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updatePayload)
        }
      );

      if (!updateResponse.ok) {
        const responseText = await updateResponse.text();
        logError('CONTACT_APPOINTMENT_IDS_DELETE_ERROR', {
          contactId,
          status: updateResponse.status,
          response: responseText
        });
      } else {
        logSuccess('CONTACT_APPOINTMENT_IDS_REMOVED', {
          contactId,
          nubimedBookingId,
          ghlAppointmentId,
          appointmentIds: appointmentIdsStr,
          bookingIds: bookingIdsStr
        });
      }
    } else {
      logWarning('BOOKING_ID_NOT_FOUND_FOR_DELETE', {
        contactId,
        nubimedBookingId
      });
    }
  } catch (error) {
    logError('REMOVE_APPOINTMENT_IDS_ERROR', {
      error: error.message,
      contactId,
      nubimedBookingId,
      ghlAppointmentId
    });
  }
}

module.exports = {
  createOrUpdateAppointment,
  deleteAppointment,
  getExistingAppointmentId,
  updateContactAppointmentIds,
  removeContactAppointmentIds,
  extractAppointmentData,
  parseCommaSeparatedIds,
  formatCommaSeparatedIds
};

