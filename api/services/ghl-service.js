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

// Format date for TEXT field (human-readable format)
function formatDateForText(date) {
  if (!date) return null;

  const d = new Date(date);
  if (isNaN(d)) return null;

  // Convert to Spain local time
  const madrid = new Date(
    d.toLocaleString("en-US", { timeZone: "Europe/Madrid" })
  );

  const day = String(madrid.getDate()).padStart(2, "0");
  const month = String(madrid.getMonth() + 1).padStart(2, "0");
  const year = madrid.getFullYear();

  const hour = String(madrid.getHours()).padStart(2, "0");
  const minute = String(madrid.getMinutes()).padStart(2, "0");

  return `${day}/${month}/${year} a las ${hour}:${minute}`;
}

// Format date for DATE field (ISO format: YYYY-MM-DD)
function formatDateForDateField(date) {
  if (!date) return null;

  const d = new Date(date);
  if (isNaN(d)) return null;

  // Convert to Spain local time
  const madrid = new Date(
    d.toLocaleString("en-US", { timeZone: "Europe/Madrid" })
  );

  const day = String(madrid.getDate()).padStart(2, "0");
  const month = String(madrid.getMonth() + 1).padStart(2, "0");
  const year = madrid.getFullYear();

  // Return ISO date format: YYYY-MM-DD
  return `${year}-${month}-${day}`;
}

// Backward compatibility - use text format by default
function formatDateForGHL(date) {
  return formatDateForText(date);
}

/**
 * Normalize country name to ISO 3166-1 alpha-2 code (2 letters uppercase)
 * GHL API requires ISO country codes, not country names
 * @param {string} country - Country name or code from Nubimed
 * @returns {string} - ISO 3166-1 alpha-2 code (e.g., "ES", "US", "MX")
 */
function normalizeCountryCode(country) {
  if (!country || typeof country !== 'string') {
    return 'ES'; // Default to Spain
  }

  // Normalize: trim whitespace and convert to lowercase
  const normalized = country.trim().toLowerCase();

  // If already a valid 2-letter code (case-insensitive), return uppercase
  if (/^[a-z]{2}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }

  // Map common country names to ISO codes
  // Focus on countries that might come from Nubimed (Spanish-speaking countries)
  const countryMap = {
    // Spain variations
    'españa': 'ES',
    'espana': 'ES', // without ñ
    'spain': 'ES',
    // Other common countries
    'méxico': 'MX',
    'mexico': 'MX',
    'méjico': 'MX',
    'mejico': 'MX',
    'colombia': 'CO',
    'argentina': 'AR',
    'chile': 'CL',
    'perú': 'PE',
    'peru': 'PE',
    'venezuela': 'VE',
    'ecuador': 'EC',
    'guatemala': 'GT',
    'cuba': 'CU',
    'bolivia': 'BO',
    'república dominicana': 'DO',
    'republica dominicana': 'DO',
    'honduras': 'HN',
    'paraguay': 'PY',
    'nicaragua': 'NI',
    'el salvador': 'SV',
    'costa rica': 'CR',
    'panamá': 'PA',
    'panama': 'PA',
    'uruguay': 'UY',
    'portugal': 'PT',
    'brasil': 'BR',
    'brazil': 'BR',
    'estados unidos': 'US',
    'united states': 'US',
    'usa': 'US',
    'reino unido': 'GB',
    'united kingdom': 'GB',
    'uk': 'GB',
    'francia': 'FR',
    'france': 'FR',
    'italia': 'IT',
    'italy': 'IT',
    'alemania': 'DE',
    'germany': 'DE',
  };

  // Check if normalized country name exists in map
  if (countryMap[normalized]) {
    return countryMap[normalized];
  }

  // If not found, default to ES (Spain) since all patients seem to be from Spain
  // Log a warning for debugging
  logWarning('COUNTRY_NOT_MAPPED', {
    original: country,
    normalized: normalized,
    defaultingTo: 'ES'
  });

  return 'ES';
}

function extractPatientData(payload) {
  const data = payload.data || payload;
  const booking = data.booking || payload.appointment || payload;
  
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
  
  // Get raw appointment date
  const rawAppointmentDate = 
    booking.start_at || 
    booking.startAt ||
    data.start_at ||
    data.startAt ||
    booking.date || 
    booking.datetime || 
    payload.date ||
    payload.datetime ||
    data.date;
  
  // Format for TEXT field (human-readable)
  const appointmentDateText = formatDateForText(rawAppointmentDate);
  
  // Format for DATE field (ISO format)
  const appointmentDateISO = formatDateForDateField(rawAppointmentDate);
  
  // Extract address fields
  const address = patient.address || booking.address || data.address || '';
  const city = patient.city || booking.city || data.city || '';
  const province = patient.province || booking.province || data.province || '';
  const postalCode = patient.postal_code || patient.postalCode || booking.postal_code || booking.postalCode || data.postal_code || data.postalCode || '';
  const country = patient.country || booking.country || data.country || 'ES'; // Default to ES for Spain
  
  // Extract birth date
  const birthDate = patient.birth_date || patient.birthDate || booking.birth_date || booking.birthDate || data.birth_date || data.birthDate || null;
  
  // Extract additional patient info for custom fields
  const nin = patient.nin || booking.nin || data.nin || null; // National ID
  const sex = patient.sex || booking.sex || data.sex || null;
  
  
  return {
    phone,
    email,
    firstName,
    lastName,
    address,
    city,
    province,
    postalCode,
    country,
    dateOfBirth: birthDate,
    nin,
    sex,
    appointmentDate: appointmentDateText, // For backward compatibility, keep this as text format
    appointmentDateText, // TEXT field format
    appointmentDateISO  // DATE field format (ISO: YYYY-MM-DD)
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

    // Check if contact_id is provided in payload (new format)
    const providedContactId = nubimedPayload.contact_id;
    
    // If contact_id is provided, we can skip contact sync and return it
    // But we still need to validate the contact exists
    if (providedContactId) {
      try {
        // Verify contact exists
        const verifyResponse = await fetch(
          `${GHL_API_BASE}/contacts/${providedContactId}`,
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_TOKEN}`,
              'Version': '2021-07-28'
            }
          }
        );

        if (verifyResponse.ok) {
          logSuccess('CONTACT_ID_PROVIDED', {
            contactId: providedContactId,
            verified: true
          });
          return {
            success: true,
            contactId: providedContactId,
            isNew: false,
            provided: true
          };
        } else {
          logWarning('CONTACT_ID_NOT_FOUND', {
            contactId: providedContactId,
            status: verifyResponse.status
          });
          // Fall through to create/update contact
        }
      } catch (verifyError) {
        logWarning('CONTACT_VERIFY_ERROR', {
          error: verifyError.message,
          contactId: providedContactId
        });
        // Fall through to create/update contact
      }
    }

    const patientData = extractPatientData(nubimedPayload);
    
    
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

    // Build custom fields array using the correct GHL API format
    // Format: customFields array with objects containing id and field_value
    // From customfields.json:
    // - fecha_ultima_cita_T: id "VK7oRWrcyv0MtiLY0MJq" (TEXT field) - needs human-readable format
    // - fecha_ultima_cita: id "SogU2vTkISpnltBjY2K8" (DATE field) - needs ISO format (YYYY-MM-DD)
    // - Rut (NIN): id "rEzf1QqhOgXzBp8bukTc" (TEXT field)
    // - Sexo: id "8JY1foA1enB0jV3V8mZ1" (TEXT field)
    const customFieldsArray = [];
    
    // TEXT field: Use human-readable format for workflows/messages
    if (patientData.appointmentDateText) {
      customFieldsArray.push({
        id: "VK7oRWrcyv0MtiLY0MJq", // fecha_ultima_cita_T (TEXT)
        field_value: patientData.appointmentDateText // "09/12/2025 a las 09:15"
      });
    }
    
    // DATE field: Use ISO format (YYYY-MM-DD) to avoid date parsing errors
    if (patientData.appointmentDateISO) {
      customFieldsArray.push({
        id: "SogU2vTkISpnltBjY2K8", // fecha_ultima_cita (DATE)
        field_value: patientData.appointmentDateISO // "2025-12-09"
      });
    }
    
    // Add NIN (Rut) custom field
    if (patientData.nin) {
      customFieldsArray.push({
        id: "rEzf1QqhOgXzBp8bukTc", // Rut (NIN)
        field_value: patientData.nin
      });
    }
    
    // Add Sex custom field (format: convert "sexo_femenino" -> "Mujer", "sexo_masculino" -> "Hombre")
    if (patientData.sex) {
      let sexValue = patientData.sex;
      if (patientData.sex === 'sexo_femenino') {
        sexValue = 'Mujer';
      } else if (patientData.sex === 'sexo_masculino') {
        sexValue = 'Hombre';
      }
      customFieldsArray.push({
        id: "8JY1foA1enB0jV3V8mZ1", // Sexo
        field_value: sexValue
      });
    }

    // Build contact data with all available fields
    const contactData = {
      locationId: GHL_LOCATION_ID,
      phone: patientData.phone,
      email: patientData.email,
      firstName: patientData.firstName,
      lastName: patientData.lastName,
      source: 'Nubimed',
      customFields: customFieldsArray.length > 0 ? customFieldsArray : undefined,
      tags: ['nubimed contact']
    };
    
    // Add address fields if available
    if (patientData.address) {
      contactData.address1 = patientData.address;
    }
    if (patientData.city) {
      contactData.city = patientData.city;
    }
    if (patientData.province) {
      contactData.state = patientData.province;
    }
    if (patientData.postalCode) {
      contactData.postalCode = patientData.postalCode;
    }
    if (patientData.country) {
      // Normalize country to ISO 3166-1 alpha-2 code (required by GHL API)
      // This handles all variations: "españa", "España", "ESPAÑA", "ES", etc.
      const countryCode = normalizeCountryCode(patientData.country);
      contactData.country = countryCode;
    }
    
    // Add date of birth if available (format: YYYY-MM-DD)
    if (patientData.dateOfBirth) {
      contactData.dateOfBirth = patientData.dateOfBirth;
    }

    // Clean up null/undefined/empty fields
    Object.keys(contactData).forEach(key => {
      const value = contactData[key];
      // Remove if null, undefined, or empty string (except for tags and customFields arrays)
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '' && key !== 'tags')) {
        delete contactData[key];
      }
    });
    
    // Clean up customFields array if empty
    if (contactData.customFields && contactData.customFields.length === 0) {
      delete contactData.customFields;
    }
    
    // Remove empty firstName/lastName (they should be strings but empty strings are not useful)
    if (contactData.firstName && contactData.firstName.trim() === '') {
      delete contactData.firstName;
    }
    if (contactData.lastName && contactData.lastName.trim() === '') {
      delete contactData.lastName;
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

