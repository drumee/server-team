/**
 * Recalculate Domain Usage - Cron Job
 * 
 * Run hourly to sync cached domain_usage with actual totals
 * Fixes any drift from failed triggers or race conditions
 * 
 * Usage:
 *   node scripts/recalc-domain-usage.js
 */

const { Mariadb } = require('@drumee/server-essentials');

async function main() {
  console.log(`[${new Date().toISOString()}] Starting domain usage recalculation...`);
  
  const yp = new Mariadb({ name: 'yp' });
  
  try {
    // Get all paid domains (domain_id > 1)
    const domains = await yp.await_run(`
      SELECT DISTINCT domain_id 
      FROM quota 
      WHERE domain_id > 1 
      ORDER BY domain_id
    `);
    
    if (!domains || domains.length === 0) {
      console.log('No paid domains found');
      await yp.end();
      return;
    }
    
    console.log(`Found ${domains.length} paid domains to recalculate`);
    
    let success = 0;
    let failed = 0;
    let totalDrift = 0;
    
    // Recalculate each domain
    for (let domain of domains) {
      const domain_id = domain.domain_id;
      
      try {
        const result = await yp.await_proc('recalculate_domain_usage', domain_id);
        
        // Parse result
        let info = result;
        if (result && result[0] && result[0].result) {
          info = result[0].result;
          if (typeof info === 'string') {
            info = JSON.parse(info);
          }
        }
        
        const drift = info.drift || 0;
        totalDrift += Math.abs(drift);
        
        if (Math.abs(drift) > 1024 * 1024) { // > 1MB drift
          console.log(`Domain ${domain_id}: Drift detected! ${(drift / 1024 / 1024).toFixed(2)} MB`);
          console.log(`Calculated: ${(info.calculated_total / 1024 / 1024).toFixed(2)} MB`);
          console.log(`Cached: ${(info.old_cached / 1024 / 1024).toFixed(2)} MB`);
        } else {
          console.log(`Domain ${domain_id}: OK (drift: ${drift} bytes)`);
        }
        
        success++;
        
      } catch (e) {
        console.error(`Domain ${domain_id}: Failed -`, e.message);
        failed++;
      }
    }
    
    console.log(`\n=== Recalculation Summary ===`);
    console.log(`  Success: ${success}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Total domains: ${domains.length}`);
    console.log(`  Total drift: ${(totalDrift / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Status: ${failed === 0 ? 'OK' : 'ERRORS'}`);
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await yp.end();
  }
  
  process.exit(0);
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Run
main();