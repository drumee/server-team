/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

const MEETING_CARD = /^\[\[MEETING:\s*(start|end)\s*:/;

/**
 * "start" | "end" for a `[[MEETING:<action>:{json}]]` card body, else null.
 * @param {string} message
 * @returns {string|null}
 */
function meetingCardAction(message) {
  const m = MEETING_CARD.exec(typeof message === "string" ? message : "");
  return m ? m[1] : null;
}

/**
 * Sockets channel.post leaves out of its push.
 *
 * Every client request carries its socket_id, and a chat post skips that
 * socket because widget_chat has already drawn the row and matches the echo.
 * A meeting card is posted by window_meeting, which draws nothing, so skipping
 * the sender left the host's own folder chat and meeting chat without the card
 * until a reload — and the later channel.meeting_end push (sent to everyone)
 * found no row to flip. Meeting cards go to every socket, the sender's too.
 *
 * @param {string} message  the posted body
 * @param {string[]|undefined} exclude  the sender's socket, as channel.post built it
 * @returns {string[]|undefined}
 */
function pushExclude(message, exclude) {
  return meetingCardAction(message) ? undefined : exclude;
}

module.exports = { meetingCardAction, pushExclude };
