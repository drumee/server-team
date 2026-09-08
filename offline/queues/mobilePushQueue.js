const Queue = require('bull');
const {resolve} = require('path');
const {readFileSync} = require('jsonfile');
const {existsSync} = require('fs');
const {sysEnv} = require('@drumee/server-essentials');

function redisConfig() {
  const environment = sysEnv();
  const credentialDir = environment.credential_dir || '/etc/drumee/credential';
  const instance = environment.instance_name || '';
  const candidates = [
    resolve(credentialDir, instance, 'redis-config.json'),
    '/etc/drumee/credential/redis.json',
    '/etc/drumee/infrastructure/redis-config.json',
  ];
  const filename = candidates.find(existsSync);
  const conf = filename ? readFileSync(filename) : {};
  return {
    host: conf.redisHost || 'localhost',
    port: conf.redisPort || 6379,
    password: conf.redisAuth || undefined,
    db: conf.redisDb || 0,
  };
}

const runtimeEnv = sysEnv();
const QUEUE_GENERATION = String(runtimeEnv.mobile_push_queue_generation || 1);

const mobilePushQueue = new Queue('drumee:mobile-push', {
  redis: redisConfig(),
  prefix: 'drumee:queue',
  defaultJobOptions: {
    attempts: 4,
    // FCM asks clients to wait at least one minute after quota (HTTP 429)
    // responses. A single conservative floor also keeps retry behavior simple.
    backoff: {type: 'exponential', delay: 60000},
    removeOnComplete: {age: 24 * 3600, count: 1000},
    removeOnFail: {age: 7 * 24 * 3600, count: 1000},
    timeout: 30000,
  },
});

async function addAdmission(event) {
  const admitted = {...event, queue_generation: QUEUE_GENERATION};
  return mobilePushQueue.add('admit-event', admitted, {
    jobId: `admit:${QUEUE_GENERATION}:${event.event_id}`,
  });
}

async function addDelivery(delivery) {
  return mobilePushQueue.add('deliver', delivery, {
    jobId: `deliver:${QUEUE_GENERATION}:${delivery.event_id}:${delivery.registration_id}`,
  });
}

async function stats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    mobilePushQueue.getWaitingCount(),
    mobilePushQueue.getActiveCount(),
    mobilePushQueue.getCompletedCount(),
    mobilePushQueue.getFailedCount(),
    mobilePushQueue.getDelayedCount(),
  ]);
  return {waiting, active, completed, failed, delayed};
}

module.exports = {
  QUEUE_GENERATION,
  mobilePushQueue,
  addAdmission,
  addDelivery,
  stats,
};
