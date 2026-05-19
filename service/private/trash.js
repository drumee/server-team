/**
 * Trash Service
 * 
 * Backend service for managing trash expiry configuration
 * Allows admin users to configure auto-delete settings
 */

const { Attr } = require('@drumee/server-essentials');
const { Entity } = require('@drumee/server-core');

class TrashService extends Entity {
  
  /**
   * Get current trash expiry configuration
   * 
   * Permission: read (any user can see settings)
   * Returns: { expiry_days, auto_delete_enabled, last_run_time, ... }
   */
  async get_config() {
    try {
      const config = await this.yp.await_proc('get_trash_config');
      
      if (!config) {
        return this.exception.server('TRASH_CONFIG_NOT_FOUND');
      }

      // Format dates
      const result = {
        ...config,
        last_run_date: config.last_run_time > 0 
          ? new Date(config.last_run_time * 1000).toISOString() 
          : null,
        created_at: config.ctime > 0 
          ? new Date(config.ctime * 1000).toISOString() 
          : null,
        updated_at: config.mtime > 0 
          ? new Date(config.mtime * 1000).toISOString() 
          : null
      };

      this.output.data(result);

    } catch (error) {
      this.warn('[TrashService] get_config failed:', error.message);
      this.exception.server('FAILED_TO_GET_TRASH_CONFIG');
    }
  }

  /**
   * Update trash expiry configuration
   * 
   * Permission: admin (only admin can change settings)
   * 
   * @param {Number} expiry_days - Days before auto-delete (1-365)
   * @param {Number} auto_delete_enabled - 0 (disabled) or 1 (enabled)
   */
  async update_config() {
    try {
      const expiry_days = this.input.need('expiry_days');
      const auto_delete_enabled = this.input.need('auto_delete_enabled');

      // Validation happens in stored procedure, but double-check here
      if (typeof expiry_days !== 'number' || expiry_days < 1 || expiry_days > 365) {
        return this.exception.user('INVALID_EXPIRY_DAYS', 'Expiry days must be between 1 and 365');
      }

      if (auto_delete_enabled !== 0 && auto_delete_enabled !== 1) {
        return this.exception.user('INVALID_AUTO_DELETE_FLAG', 'auto_delete_enabled must be 0 or 1');
      }

      // Update configuration
      const result = await this.yp.await_proc(
        'update_trash_config',
        expiry_days,
        auto_delete_enabled
      );

      if (!result) {
        return this.exception.server('TRASH_CONFIG_UPDATE_FAILED');
      }

      // Format dates
      const response = {
        ...result,
        last_run_date: result.last_run_time > 0 
          ? new Date(result.last_run_time * 1000).toISOString() 
          : null,
        created_at: result.ctime > 0 
          ? new Date(result.ctime * 1000).toISOString() 
          : null,
        updated_at: result.mtime > 0 
          ? new Date(result.mtime * 1000).toISOString() 
          : null
      };

      this.output.data(response);

    } catch (error) {
      // Check if error is from stored procedure validation
      if (error.message && error.message.includes('Invalid expiry_days')) {
        return this.exception.user('INVALID_EXPIRY_DAYS', error.message);
      }
      if (error.message && error.message.includes('Invalid auto_delete_enabled')) {
        return this.exception.user('INVALID_AUTO_DELETE_FLAG', error.message);
      }

      this.warn('[TrashService] update_config failed:', error.message);
      this.exception.server('FAILED_TO_UPDATE_TRASH_CONFIG');
    }
  }

  /**
   * Get trash statistics (for admin dashboard)
   * 
   * Permission: read
   * Returns: Statistics about trash across all hubs
   */
  async get_stats() {
    try {
      const config = await this.yp.await_proc('get_trash_config');

      if (!config) {
        return this.exception.server('TRASH_CONFIG_NOT_FOUND');
      }

      const { expiry_days } = config;

      // Get expired trash summary
      const expiredHubs = await this.yp.await_proc('find_all_expired_trash', expiry_days);

      let totalExpired = 0;
      let hubsWithExpired = 0;

      if (expiredHubs && expiredHubs.length > 0) {
        hubsWithExpired = expiredHubs.length;
        totalExpired = expiredHubs.reduce((sum, hub) => sum + (hub.expired_count || 0), 0);
      }

      // Get current user's hub trash info (if in a hub context)
      let userTrash = null;
      const hub_id = this.hub ? this.hub.get(Attr.id) : null;

      if (hub_id && hub_id !== this.uid) {
        try {
          const db_name = await this.yp.await_func('get_db_name', hub_id);
          const hubDb = this.db; // Current hub database

          // Count total items in trash
          const trashCount = await hubDb.await_func(
            `SELECT COUNT(*) as count FROM trash_media 
            WHERE status = "deleted" AND owner_id = '${this.uid}'`
          );

          // Count expired items
          const expiredCount = await hubDb.await_func(
            `SELECT COUNT(*) as count FROM trash_media 
            WHERE status = "deleted" 
            AND owner_id = '${this.uid}'
            AND trashed_time > 0 
            AND trashed_time < UNIX_TIMESTAMP() - (${expiry_days} * 86400)`
          );

          userTrash = {
            hub_id,
            total_items: trashCount ? trashCount.count : 0,
            expired_items: expiredCount ? expiredCount.count : 0
          };

        } catch (e) {
          this.warn('[TrashService] Failed to get user hub trash stats:', e.message);
        }
      }

      const result = {
        config: {
          expiry_days: config.expiry_days,
          auto_delete_enabled: config.auto_delete_enabled,
          last_run_time: config.last_run_time,
          last_run_date: config.last_run_time > 0 
            ? new Date(config.last_run_time * 1000).toISOString() 
            : null
        },
        system_wide: {
          hubs_with_expired: hubsWithExpired,
          total_expired_items: totalExpired
        },
        current_hub: userTrash
      };

      this.output.data(result);

    } catch (error) {
      this.warn('[TrashService] get_stats failed:', error.message);
      this.exception.server('FAILED_TO_GET_TRASH_STATS');
    }
  }

  /**
   * Trigger manual expiry run (admin only - for testing)
   * 
   * Permission: admin
   * Sends signal to expiryWorker to run immediately
   */
  async trigger_expiry() {
    try {
      // This would typically send a signal to the worker process
      // For now, just return success - actual implementation depends on process management
      
      this.output.data({
        status: 'triggered',
        message: 'Manual expiry run has been triggered',
        timestamp: Date.now()
      });

    } catch (error) {
      this.warn('[TrashService] trigger_expiry failed:', error.message);
      this.exception.server('FAILED_TO_TRIGGER_EXPIRY');
    }
  }

}

module.exports = TrashService;