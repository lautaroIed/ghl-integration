const { logError, logSuccess, logWarning } = require('../utils/logger');

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
  const appointment = payload.appointment || payload;
  const patient = appointment.patient || payload.patient || {};
  
  const phone = formatPhone(
    patient.phone || 
    payload.patient_phone || 
    payload.phone ||
    appointment.phone
  );
  
  const email = 
    patient.email || 
    payload.patient_email || 
    payload.email ||
    appointment.email ||
    null;
  
  const firstName = 
    patient.name || 
    patient.firstName || 
    payload.patient_name ||
    payload.firstName ||
    payload.name ||
    '';
  
  const lastName = 
    patient.lastName || 
    patient.last_name ||
    payload.patient_lastName ||
    payload.lastName ||
    '';
  
  const appointmentDate = formatDateForGHL(
    appointment.date || 
    appointment.datetime || 
    payload.date ||
    payload.datetime
  );
  
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

    const patientData = extractPatientData(nubimedPayload);
    
    if (!patientData.phone && !patientData.email) {
      throw new Error('Phone or email is required to sync contact');
    }
    
    if (!patientData.appointmentDate) {
      throw new Error('Appointment date is required');
    }

    const contactData = {
      phone: patientData.phone,
      email: patientData.email,
      firstName: patientData.firstName,
      lastName: patientData.lastName,
      source: 'Nubimed',
      customField: {
        fecha_ultima_cita_t: patientData.appointmentDate
      },
      tags: ['nubimed contact']
    };

    Object.keys(contactData).forEach(key => {
      if (contactData[key] === undefined || contactData[key] === null) {
        delete contactData[key];
      }
    });

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

