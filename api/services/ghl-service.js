const logger = require('../utils/logger');
const { logError, logSuccess, logWarning } = logger;

const GHL_API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_API_TOKEN = process.env.GHL_API_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

function formatPhone(phone) {
  if (!phone) return null;
  
  let cleaned = String(phone).replace(/[^\d+]/g, '');
  
  if (cleaned && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  
  return cleaned || null;
}

function formatDateForGHL(date) {
  if (!date) return null;
  
  try {
    const dateObj = new Date(date);
    
    if (isNaN(dateObj.getTime())) {
      throw new Error(`Invalid date format: ${date}`);
    }
    
    return dateObj.toISOString();
  } catch (error) {
    logError('DATE_FORMAT_ERROR', { date, error: error.message });
    return null;
  }
}

function extractPatientData(payload) {
  const data = payload.data || payload;
  const booking = data.booking || payload.appointment || payload;
  
  // Log structure for debugging
  logWarning('EXTRACTION_START', {
    hasData: !!data,
    hasBooking: !!booking,
    dataKeys: data ? Object.keys(data) : [],
    bookingKeys: booking ? Object.keys(booking) : [],
    hasDataPatients: !!(data && data.patients),
    hasBookingPatients: !!(booking && booking.patients)
  });
  
  let patient = {};
  let patientSource = 'none';
  
  // Try multiple possible locations for patient data
  // PRIORITY 1: data.booking.patients[] (array inside booking - THIS IS THE ACTUAL STRUCTURE)
  // This is the most common structure from Nubimed
  if (booking && booking.patients && Array.isArray(booking.patients) && booking.patients.length > 0) {
    patient = booking.patients[0];
    patientSource = 'booking.patients[0]';
    logWarning('FOUND_PATIENT_IN_BOOKING', {
      patientKeys: Object.keys(patient),
      phone: patient.phone,
      email: patient.email,
      patientId: patient.id
    });
  }
  // PRIORITY 2: data.patients[] (array at data level)
  else if (data.patients && Array.isArray(data.patients) && data.patients.length > 0) {
    patient = data.patients[0];
    patientSource = 'data.patients[0]';
  }
  // PRIORITY 3: booking.patient (single object)
  else if (booking && booking.patient) {
    patient = booking.patient;
    patientSource = 'booking.patient';
  }
  // PRIORITY 4: payload.patient (fallback)
  else {
    patient = payload.patient || {};
    patientSource = 'payload.patient';
    logWarning('NO_PATIENT_FOUND', {
      hasBooking: !!booking,
      hasData: !!data,
      bookingKeys: booking ? Object.keys(booking) : [],
      dataKeys: data ? Object.keys(data) : []
    });
  }
  
  // Log patient extraction for debugging
  logWarning('PATIENT_EXTRACTION', {
    patientSource,
    hasPatient: !!patient && Object.keys(patient).length > 0,
    patientKeys: patient ? Object.keys(patient) : [],
    hasPhone: !!patient.phone,
    hasEmail: !!patient.email,
    phone: patient.phone,
    email: patient.email,
    rawPhone: patient.phone,
    rawEmail: patient.email,
    hasBookingPatients: !!(booking && booking.patients),
    hasDataPatients: !!(data && data.patients),
    bookingKeys: booking ? Object.keys(booking) : [],
    dataKeys: data ? Object.keys(data) : [],
    bookingPatientsLength: booking && booking.patients ? booking.patients.length : 0,
    dataPatientsLength: data && data.patients ? data.patients.length : 0
  });
  
  const phone = formatPhone(
    patient.phone || 
    payload.patient_phone || 
    payload.phone ||
    booking.phone ||
    data.phone
  );
  
  const email = 
    patient.email || 
    payload.patient_email || 
    payload.email ||
    booking.email ||
    data.email ||
    null;
  
  const firstName = 
    patient.name || 
    patient.firstName || 
    payload.patient_name ||
    payload.firstName ||
    payload.name ||
    booking.patient_name ||
    '';
  
  const lastName = 
    patient.surname || 
    patient.lastName || 
    patient.last_name ||
    payload.patient_lastName ||
    payload.lastName ||
    booking.patient_lastName ||
    '';
  
  const appointmentDate = formatDateForGHL(
    booking.start_at || 
    booking.startAt ||
    data.start_at ||
    data.startAt ||
    booking.date || 
    booking.datetime || 
    payload.date ||
    payload.datetime ||
    data.date
  );
  
  // Log final extracted values for debugging
  logWarning('EXTRACTED_PATIENT_DATA', {
    phone: phone || 'NULL',
    email: email || 'NULL',
    firstName: firstName || 'NULL',
    lastName: lastName || 'NULL',
    appointmentDate: appointmentDate || 'NULL',
    patientSource,
    patientObject: JSON.stringify(patient).substring(0, 200)
  });
  
  return {
    phone,
    email,
    firstName,
    lastName,
    appointmentDate
  };
}

async function syncToGHL(nubimedPayload) {
  try {
    if (!GHL_API_TOKEN) {
      throw new Error('GHL_API_TOKEN environment variable is required');
    }

    if (!GHL_LOCATION_ID) {
      throw new Error('GHL_LOCATION_ID environment variable is required');
    }

    const patientData = extractPatientData(nubimedPayload);
    
    // Log extracted data for debugging
    logWarning('PATIENT_DATA_EXTRACTED', {
      phone: patientData.phone,
      email: patientData.email,
      firstName: patientData.firstName,
      lastName: patientData.lastName,
      appointmentDate: patientData.appointmentDate,
      hasPhone: !!patientData.phone,
      hasEmail: !!patientData.email,
      locationId: GHL_LOCATION_ID
    });
    
    if (!patientData.phone && !patientData.email) {
      logError('MISSING_CONTACT_INFO', {
        patientData,
        payload: JSON.stringify(nubimedPayload).substring(0, 500)
      });
      throw new Error('Phone or email is required to sync contact');
    }
    
    if (!patientData.appointmentDate) {
      throw new Error('Appointment date is required');
    }

    // Build custom fields object using fieldKey (without "contact." prefix)
    // According to GHL API docs, custom fields use fieldKey as property name
    // From customfields.json:
    // - fecha_ultima_cita_T: fieldKey "contact.fecha_ultima_cita_t" -> use "fecha_ultima_cita_t"
    // - fecha_ultima_cita: fieldKey "contact.fecha_ultima_cita" -> use "fecha_ultima_cita"
    const customFields = {};
    
    if (patientData.appointmentDate) {
      // Update fecha_ultima_cita_T (TEXT field) - the one used in workflows
      customFields.fecha_ultima_cita_t = patientData.appointmentDate;
      
      // Also update fecha_ultima_cita (DATE field) for consistency
      customFields.fecha_ultima_cita = patientData.appointmentDate;
    }

    const contactData = {
      locationId: GHL_LOCATION_ID,
      phone: patientData.phone,
      email: patientData.email,
      firstName: patientData.firstName,
      lastName: patientData.lastName,
      source: 'Nubimed',
      customField: Object.keys(customFields).length > 0 ? customFields : undefined,
      tags: ['nubimed contact']
    };

    // Clean up null/undefined fields
    Object.keys(contactData).forEach(key => {
      if (contactData[key] === undefined || contactData[key] === null) {
        delete contactData[key];
      }
    });
    
    // Clean up customField object if empty
    if (contactData.customField) {
      Object.keys(contactData.customField).forEach(key => {
        if (contactData.customField[key] === null || contactData.customField[key] === undefined) {
          delete contactData.customField[key];
        }
      });
      
      if (Object.keys(contactData.customField).length === 0) {
        delete contactData.customField;
      }
    }

    logSuccess('SYNC_ATTEMPT', {
      contactData,
      patientData
    });

    const response = await fetch(`${GHL_API_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(contactData)
    });

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON response: ${responseText}`);
    }

    if (!response.ok) {
      logError('GHL_API_ERROR', {
        status: response.status,
        statusText: response.statusText,
        response: result
      });
      
      throw new Error(`GHL API error (${response.status}): ${result.message || JSON.stringify(result)}`);
    }

    const contactId = result.contact?.id || result.id;
    const isNew = result.contact?.createdAt === result.contact?.updatedAt;

    logSuccess('SYNC_SUCCESS', {
      contactId,
      isNew,
      result
    });

    return {
      success: true,
      contactId,
      isNew,
      result
    };

  } catch (error) {
    logError('SYNC_ERROR', {
      error: error.message,
      stack: error.stack,
      payload: nubimedPayload
    });
    throw error;
  }
}

async function searchContact(phone, email) {
  try {
    const searchParams = new URLSearchParams();
    if (phone) searchParams.append('phone', phone);
    if (email) searchParams.append('email', email);

    const response = await fetch(
      `${GHL_API_BASE}/contacts/search?${searchParams.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_TOKEN}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Search failed: ${response.statusText}`);
    }

    const result = await response.json();
    return result.contacts?.[0] || null;

  } catch (error) {
    logError('SEARCH_ERROR', { error: error.message, phone, email });
    return null;
  }
}

module.exports = {
  syncToGHL,
  searchContact,
  formatPhone,
  formatDateForGHL,
  extractPatientData
};

