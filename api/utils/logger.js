const LOG_LEVELS = {
  INFO: 'INFO',
  ERROR: 'ERROR',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING'
};

function formatLog(level, event, data) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    data
  };
}

function logWebhook(event, data) {
  const log = formatLog(LOG_LEVELS.INFO, event, data);
  console.log(JSON.stringify(log));
  
}

function logError(event, data) {
  const log = formatLog(LOG_LEVELS.ERROR, event, data);
  console.error(JSON.stringify(log));
  
}

function logSuccess(event, data) {
  const log = formatLog(LOG_LEVELS.SUCCESS, event, data);
  console.log(JSON.stringify(log));
}

function logWarning(event, data) {
  const log = formatLog(LOG_LEVELS.WARNING, event, data);
  console.warn(JSON.stringify(log));
}

module.exports = {
  logWebhook,
  logError,
  logSuccess,
  logWarning
};

