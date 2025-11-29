function shouldProcessWebhook(payload) {
  console.log('Filtering payload:', JSON.stringify(payload, null, 2));

  const eventType = payload.event_type || payload.event || payload.action;
  
  if (eventType === 'created' || eventType === 'appointment.created') {
    console.log('Processing: New appointment created');
    return true;
  }

  if (eventType === 'updated' || eventType === 'appointment.updated' || payload.appointment) {
    
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
      const previousStatus = appointment.previous_status || payload.previous_status;
      
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
    
    console.log('Warning: Cannot determine what changed - processing by default');
    return true;
  }

  console.log('Processing: Default behavior');
  return true;
}

function isCompletionStatus(status) {
  if (!status) return false;
  
  const completionStatuses = [
    'asiste',
    'completada',
    'completed',
    'attended',
    'asistida'
  ];
  
  const statusLower = String(status).toLowerCase();
  return completionStatuses.some(completion => 
    statusLower.includes(completion)
  );
}

function extractAppointmentData(payload) {
  const appointment = payload.appointment || payload;
  
  return {
    id: appointment.id || payload.id,
    date: appointment.date || appointment.datetime || payload.date,
    time: appointment.time || payload.time,
    status: appointment.status || payload.status,
    patient: appointment.patient || payload.patient || {
      name: payload.patient_name || payload.name,
      lastName: payload.patient_lastName || payload.lastName,
      phone: payload.patient_phone || payload.phone,
      email: payload.patient_email || payload.email
    }
  };
}

module.exports = {
  shouldProcessWebhook,
  extractAppointmentData,
  isCompletionStatus
};

