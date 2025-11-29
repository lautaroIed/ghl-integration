function shouldProcessWebhook(payload) {
  console.log('Filtering payload:', JSON.stringify(payload, null, 2));

  const data = payload.data || payload;
  const booking = data.booking || payload.appointment || payload;
  
  const eventName = payload.name || 
                    booking.name || 
                    data.name ||
                    payload.event_type || 
                    payload.event || 
                    payload.action;
  
  if (eventName && typeof eventName === 'string') {
    const eventLower = eventName.toLowerCase();
    
    const nonBookingEvents = [
      'cita_completada',           
      'cita_eliminada',           
      'booking_completed',        
      'booking_deleted',          
      'nueva_factura',            
      'new_invoice',              
      'tratamiento_completado',   
      'treatment_completed',      
      'paciente_creado_actualizado',
      'patient_created_updated',  
      'new_or_updated_patient',   
      'presupuesto_creado_actualizado',
      'budget_created_updated'
    ];
    
    const isNonBookingEvent = nonBookingEvents.some(event => eventLower.includes(event));
    
    if (isNonBookingEvent) {
      console.log(`Ignoring: Non-booking callback event from Nubimed (${eventName})`);
      return false;
    }
    
    if (eventLower.includes('patient') && !eventLower.includes('booking')) {
      const hasBookingData = booking && (booking.id || booking.start_at || booking.startAt || booking.date);
      
      if (!hasBookingData) {
        console.log(`Ignoring: Patient-only event without booking data (${eventName})`);
        return false;
      }
      console.log(`Processing: Patient event but has booking data (${eventName})`);
    }
  }
  
  const status = booking.status !== undefined ? booking.status : (payload.status || data.status);
  
  if (eventName && typeof eventName === 'string') {
    const eventLower = eventName.toLowerCase();
    
    if (eventLower.includes('new_booking')) {
      console.log(`Processing: New booking event (${eventName}) - this is a creation, not attendance`);
      return true;
    }
    
    if (eventLower.includes('new_or_updated')) {
      const status = booking.status !== undefined ? booking.status : (payload.status || data.status);
      
      const startAt = booking.start_at || booking.startAt || data.start_at || data.startAt;
      if (startAt) {
        console.log(`Processing: new_or_updated_booking with start_at - processing to be safe (${eventName})`);
        return true;
      }
      
      if (isCompletionStatusCode(status) && !startAt) {
        console.log(`Ignoring: new_or_updated_booking with completion status and no date (${eventName}, status: ${status})`);
        return false;
      }
    }
    
    if (eventLower.includes('booking_created') || eventLower.includes('created')) {
      console.log(`Processing: New booking created (${eventName})`);
      return true;
    }
    
    if ((eventLower.includes('attended') || eventLower.includes('asiste')) && !eventLower.includes('new')) {
      if (isCompletionStatus(status) || isCompletionStatusCode(status)) {
        console.log(`Ignoring: Attendance/completion event detected (${eventName}, status: ${status})`);
        return false;
      }
    }
    
    if (eventLower.includes('completed') && !eventLower.includes('new') && !eventLower.includes('booking_created')) {
      if (isCompletionStatus(status) || isCompletionStatusCode(status)) {
        console.log(`Ignoring: Status changed to completed (${eventName}, status: ${status})`);
        return false;
      }
    }
    
    if (eventLower.includes('updated') || eventLower.includes('modified')) {
      const startAt = booking.start_at || booking.startAt || booking.date;
      const previousStartAt = booking.previous_start_at || booking.previousStartAt || payload.previous_date || data.previous_start_at;
      
      if (previousStartAt && startAt && previousStartAt !== startAt) {
        console.log('Processing: Appointment date/time changed');
        return true;
      }
      
      if (isCompletionStatus(status) || isCompletionStatusCode(status)) {
        console.log(`Ignoring: Only status changed to completion (${status})`);
        return false;
      }
    }
  }
  
  if (typeof status === 'number') {
    const startAt = booking.start_at || booking.startAt || data.start_at || data.startAt;
    
    if (status === 5) {
      if (startAt) {
        console.log(`Processing: Status 5 with start_at - processing (${eventName || 'no event name'})`);
        return true;
      } else {
        console.log(`Ignoring: Status 5 without start_at - likely status-only change`);
        return false;
      }
    }
    
    if (status === 4) {
      console.log(`Processing: Status 4 - confirmed/scheduled booking`);
      return true;
    }
    
    if (isCompletionStatusCode(status)) {
      if (eventName && eventName.toLowerCase().includes('new_booking')) {
        console.log(`Processing: New booking with status ${status} (${eventName})`);
        return true;
      }
      
      if (startAt) {
        console.log(`Processing: Completion status ${status} with start_at - processing to be safe`);
        return true;
      }
      
      console.log(`Ignoring: Status code indicates completion without valid date (${status})`);
      return false;
    }
  }
  
  const eventType = payload.event_type || payload.event || payload.action;
  if (eventType === 'created' || eventType === 'appointment.created') {
    console.log('Processing: New appointment created');
    return true;
  }

  if (eventType === 'updated' || eventType === 'appointment.updated') {
    const appointment = payload.appointment || payload;
    
    if (payload.changes) {
      if (payload.changes.date || payload.changes.time || payload.changes.datetime) {
        console.log('Processing: Date/time changed');
        return true;
      }
      
      if (payload.changes.status && !payload.changes.date && !payload.changes.time) {
        const status = appointment.status || payload.status;
        if (isCompletionStatus(status)) {
          console.log('Ignoring: Status changed to completion status (date unchanged)');
          return false;
        }
      }
    }
    
    if (payload.previous_status || payload.previous_date || appointment.previous_date) {
      const currentDate = appointment.date || appointment.datetime || payload.date;
      const previousDate = appointment.previous_date || payload.previous_date;
      
      const currentStatus = appointment.status || payload.status;
      const previousStatus = payload.previous_status || payload.previous_status;
      
      if (previousDate && currentDate && previousDate !== currentDate) {
        console.log('Processing: Date changed');
        return true;
      }
      
      if (previousStatus && currentStatus && previousStatus !== currentStatus) {
        if (!previousDate || previousDate === currentDate) {
          if (isCompletionStatus(currentStatus)) {
            console.log('Ignoring: Only status changed to completion (date unchanged)');
            return false;
          }
        }
      }
    }
  }
  
  if (booking && (booking.start_at || booking.startAt || booking.date)) {
    if (eventName && (eventName.toLowerCase().includes('new') || eventName.toLowerCase().includes('created'))) {
      console.log('Processing: New booking detected with date');
      return true;
    }
    
    console.log('Processing: Booking data found, processing by default');
    return true;
  }

  const hasBookingData = booking && (booking.id || booking.start_at || booking.startAt || booking.date);
  if (!hasBookingData) {
    console.log('Ignoring: No booking data found - this is not a booking event');
    return false;
  }

  console.log('Warning: Cannot determine event type - processing by default');
  return true;
}

function isCompletionStatus(status) {
  if (!status) return false;
  
  const completionStatuses = [
    'asiste',
    'completada',
    'completed',
    'attended',
    'asistida',
    'completed',
    'finalizada'
  ];
  
  const statusLower = String(status).toLowerCase();
  return completionStatuses.some(completion => 
    statusLower.includes(completion)
  );
}

function isCompletionStatusCode(statusCode) {
  if (typeof statusCode !== 'number') return false;
  
  const completionCodes = [];
  
  return completionCodes.includes(statusCode);
}

function extractAppointmentData(payload) {
  const data = payload.data || payload;
  const booking = data.booking || payload.appointment || payload;
  const appointment = payload.appointment || payload;
  
  return {
    id: booking.id || appointment.id || payload.id,
    date: booking.start_at || booking.startAt || booking.date || appointment.date || appointment.datetime || payload.date,
    time: booking.start_at || booking.startAt || appointment.time || payload.time,
    status: booking.status || appointment.status || payload.status,
    patient: data.patients && Array.isArray(data.patients) && data.patients.length > 0 
      ? data.patients[0] 
      : (appointment.patient || payload.patient || {
          name: payload.patient_name || payload.name,
          lastName: payload.patient_lastName || payload.lastName,
          phone: payload.patient_phone || payload.phone,
          email: payload.patient_email || payload.email
        })
  };
}

module.exports = {
  shouldProcessWebhook,
  extractAppointmentData,
  isCompletionStatus,
  isCompletionStatusCode
};
