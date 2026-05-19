#!/usr/bin/env node

/**
 * SEO Indexing Queue Monitor
 * 
 * CLI tool for managing and monitoring the indexing queue
 * 
 * Usage:
 *   node queue-monitor.js stats          - Show queue statistics
 *   node queue-monitor.js health         - Check queue health
 *   node queue-monitor.js failed         - List failed jobs
 *   node queue-monitor.js retry [jobId]  - Retry failed job(s)
 *   node queue-monitor.js clean          - Clean old completed jobs
 *   node queue-monitor.js pause          - Pause the queue
 *   node queue-monitor.js resume         - Resume the queue
 */

const indexQueue = require('../queues/indexQueue');

const COMMANDS = {
  stats: 'Show queue statistics',
  health: 'Check queue health',
  failed: 'List failed jobs',
  retry: 'Retry failed job(s)',
  clean: 'Clean old completed jobs',
  pause: 'Pause the queue',
  resume: 'Resume the queue',
  help: 'Show this help message'
};

async function showStats() {
  console.log('\nQueue Statistics:\n');
  
  const stats = await indexQueue.getStats();
  
  console.log(`  Waiting:   ${stats.waiting}`);
  console.log(`  Active:    ${stats.active}`);
  console.log(`  Completed: ${stats.completed}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log(`  Delayed:   ${stats.delayed}`);
  console.log(`  Paused:    ${stats.paused ? 'Yes' : 'No'}`);
  console.log(`  Total:     ${stats.total}\n`);
}

async function showHealth() {
  console.log('\nQueue Health:\n');
  
  const health = await indexQueue.getHealth();
  
  const status = health.healthy ? 'HEALTHY' : 'UNHEALTHY';
  console.log(`  Status:       ${status}`);
  console.log(`  Paused:       ${health.paused ? 'Yes' : 'No'}`);
  console.log(`  Failure Rate: ${(health.failureRate * 100).toFixed(2)}%`);
  
  if (health.stats) {
    console.log(`  Waiting:      ${health.stats.waiting}`);
    console.log(`  Active:       ${health.stats.active}`);
    console.log(`  Failed:       ${health.stats.failed}`);
  }
  console.log();
}

async function listFailed() {
  console.log('\nFailed Jobs:\n');
  
  const failed = await indexQueue.getFailed(0, 10);
  
  if (failed.length === 0) {
    console.log('  No failed jobs\n');
    return;
  }
  
  for (let job of failed) {
    console.log(`  Job ${job.id}:`);
    console.log(`    File:     ${job.data.node?.filename || 'unknown'}`);
    console.log(`    Attempts: ${job.attemptsMade}`);
    console.log(`    Failed:   ${new Date(job.finishedOn).toLocaleString()}`);
    console.log(`    Error:    ${job.failedReason || 'unknown'}`);
    console.log();
  }
}

async function retryFailed(jobId) {
  if (jobId) {
    console.log(`\nRetrying job ${jobId}...\n`);
    await indexQueue.retryJob(jobId);
    console.log('  Done!\n');
  } else {
    console.log('\nRetrying all failed jobs...\n');
    const count = await indexQueue.retryAllFailed();
    console.log(`  Retried ${count} jobs\n`);
  }
}

async function cleanOld() {
  console.log('\nCleaning old completed jobs...\n');
  
  const count = await indexQueue.cleanOldJobs();
  console.log(`  Cleaned ${count} jobs\n`);
}

async function pauseQueue() {
  console.log('\nPausing queue...\n');
  await indexQueue.pause();
  console.log('  Queue paused\n');
}

async function resumeQueue() {
  console.log('\nResuming queue...\n');
  await indexQueue.resume();
  console.log('  Queue resumed\n');
}

function showHelp() {
  console.log('\nSEO Indexing Queue Monitor\n');
  console.log('Usage: node queue-monitor.js <command> [options]\n');
  console.log('Commands:\n');
  
  for (let [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(10)} ${desc}`);
  }
  console.log();
}

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  try {
    switch (command) {
      case 'stats':
        await showStats();
        break;
      case 'health':
        await showHealth();
        break;
      case 'failed':
        await listFailed();
        break;
      case 'retry':
        await retryFailed(arg);
        break;
      case 'clean':
        await cleanOld();
        break;
      case 'pause':
        await pauseQueue();
        break;
      case 'resume':
        await resumeQueue();
        break;
      case 'help':
      default:
        showHelp();
    }
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
  
  await indexQueue.close();
  process.exit(0);
}

main();