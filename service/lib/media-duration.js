/**
 * Seconds of a video node, read from <home_dir>/__storage__/<nid>/info.json
 * (orig.format.duration — ffprobe output written at transcode time; the media
 * table itself stores no duration). null when absent or unreadable.
 *
 * The nid must be a plain id: anything with a path separator or a dot is
 * refused, so the read can never leave __storage__.
 *
 * Shared by channel.media_list (workspace chats) and chat.p2p_media_list
 * (direct chats), for the Chat details Videos page.
 */
const { join } = require("path");
const { readFile } = require("fs").promises;

async function mediaInfoDuration(home_dir, nid) {
  try {
    if (!home_dir || !/^[\w-]+$/.test(`${nid || ""}`)) return null;
    const info = JSON.parse(
      await readFile(join(home_dir, "__storage__", `${nid}`, "info.json"), "utf8"),
    );
    const d = Number(info && info.orig && info.orig.format && info.orig.format.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (e) {
    return null;
  }
}

module.exports = { mediaInfoDuration };
