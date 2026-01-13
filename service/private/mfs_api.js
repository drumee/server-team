// File: server-team/service/mfs_api.js
// Purpose: MFS API service for managing export tokens
// This service handles token creation, revocation, and listing

const { toArray, Attr } = require('@drumee/server-essentials');
const { Mfs } = require('@drumee/server-core');

class MfsApi extends Mfs {

  /**
   * Initialize the service
   */
  initialize(opt) {
    super.initialize(opt);
    this.debug("[MFS_API] Service initialized");
  }

  /**
   * Create a new MFS export token
   * 
   * Request parameters:
   * - hub_id: Hub ID containing the resource
   * - node_id: Node ID (resource) to grant access to
   * - expiry_hours: Token expiry time in hours (0 = no expiry, default 24)
   * - permission: Permission level (default 2 = read)
   * 
   * Returns:
   * - token: Generated token string
   * - pseudo_entity_uid: Pseudo entity identifier
   * - expiry_time: Unix timestamp of expiry (0 = never)
   */
  async create_token() {
    try {
      const hubId = this.input.get(Attr.hub_id);
      const nodeId = this.input.get(Attr.nid);
      const expiryHours = parseInt(this.input.get('expiry_hours') || '24');
      const permission = parseInt(this.input.get('permission') || '2');
      const userId = this.uid;

      if (!hubId || !nodeId) {
        this.debug("[MFS_API] Missing required parameters: hub_id or nid");
        return this.output.data({
          status: 'error',
          error: 'missing_parameters',
          message: 'hub_id and nid are required'
        });
      }

      if (!userId) {
        this.debug("[MFS_API] User not authenticated");
        return this.output.data({
          status: 'error',
          error: 'unauthorized',
          message: 'User not authenticated'
        });
      }

      // Validate expiry_hours range (0 to 8760 hours = 1 year max)
      if (expiryHours < 0 || expiryHours > 8760) {
        this.debug("[MFS_API] Invalid expiry_hours:", expiryHours);
        return this.output.data({
          status: 'error',
          error: 'invalid_expiry',
          message: 'expiry_hours must be between 0 and 8760 (1 year)'
        });
      }

      // Validate permission level (2 = read, 3 = read+write, etc.)
      if (permission < 1 || permission > 63) {
        this.debug("[MFS_API] Invalid permission level:", permission);
        return this.output.data({
          status: 'error',
          error: 'invalid_permission',
          message: 'permission must be between 1 and 63'
        });
      }

      this.debug(`[MFS_API] Creating token: hub_id=${hubId}, node_id=${nodeId}, user_id=${userId}, expiry_hours=${expiryHours}`);

      let result = await this.yp.await_proc(
        'mfs_token_create',
        hubId,
        nodeId,
        userId,
        expiryHours,
        permission
      );

      result = toArray(result)[0];

      if (result && result.failed === 1) {
        this.warn("[MFS_API] Token creation failed:", result.reason);
        return this.output.data({
          status: 'error',
          error: 'token_creation_failed',
          message: result.reason
        });
      }

      this.debug("[MFS_API] Token created successfully:", result.token);

      return this.output.data({
        status: 'ok',
        token: result.token,
        pseudo_entity_uid: result.pseudo_entity_uid,
        hub_id: result.hub_id,
        node_id: result.node_id,
        expiry_time: result.expiry_time,
        ctime: result.ctime,
        message: result.message
      });

    } catch (error) {
      this.warn("[MFS_API] Exception in create_token:", error.message);
      return this.output.data({
        status: 'error',
        error: 'internal_error',
        message: 'Failed to create token: ' + error.message
      });
    }
  }

  /**
   * Revoke an existing MFS export token
   * 
   * Request parameters:
   * - token: Token string to revoke
   * 
   * Returns:
   * - status: ok or error
   */
  async revoke() {
    try {
      const token = this.input.get('token');
      const userId = this.uid;

      if (!token) {
        this.debug("[MFS_API] Missing token parameter");
        return this.output.data({
          status: 'error',
          error: 'missing_token',
          message: 'token parameter is required'
        });
      }

      if (!userId) {
        this.debug("[MFS_API] User not authenticated");
        return this.output.data({
          status: 'error',
          error: 'unauthorized',
          message: 'User not authenticated'
        });
      }

      this.debug(`[MFS_API] Revoking token: ${token.substring(0, 8)}... by user ${userId}`);

      let result = await this.yp.await_proc('mfs_token_revoke', token, userId);
      result = toArray(result)[0];

      if (result && result.failed === 1) {
        this.warn("[MFS_API] Token revocation failed:", result.reason);
        return this.output.data({
          status: 'error',
          error: 'revocation_failed',
          message: result.reason
        });
      }

      this.debug("[MFS_API] Token revoked successfully");

      return this.output.data({
        status: 'ok',
        token: result.token,
        hub_id: result.hub_id,
        node_id: result.node_id,
        message: result.message
      });

    } catch (error) {
      this.warn("[MFS_API] Exception in revoke:", error.message);
      return this.output.data({
        status: 'error',
        error: 'internal_error',
        message: 'Failed to revoke token: ' + error.message
      });
    }
  }

  /**
   * List all tokens created by current user
   * 
   * Returns:
   * - tokens: Array of token objects with details
   */
  async list() {
    try {
      const userId = this.uid;

      if (!userId) {
        this.debug("[MFS_API] User not authenticated");
        return this.output.data({
          status: 'error',
          error: 'unauthorized',
          message: 'User not authenticated'
        });
      }

      this.debug(`[MFS_API] Listing tokens for user ${userId}`);

      let tokens = await this.yp.await_proc('mfs_token_list', userId);
      tokens = toArray(tokens);

      this.debug(`[MFS_API] Found ${tokens.length} tokens`);

      return this.output.data({
        status: 'ok',
        tokens: tokens,
        count: tokens.length
      });

    } catch (error) {
      this.warn("[MFS_API] Exception in list:", error.message);
      return this.output.data({
        status: 'error',
        error: 'internal_error',
        message: 'Failed to list tokens: ' + error.message
      });
    }
  }

}

module.exports = MfsApi;