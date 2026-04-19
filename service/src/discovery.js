// discovery.js — UDP broadcast responder for local network PAN hub discovery.
//
// The installer broadcasts "PAN_DISCOVER" on port 7778 and this server replies
// with "PAN_HERE:{json}" so installers can find the hub automatically on LAN
// or Tailscale without any manual IP entry.
//
// Protocol:
//   Client → broadcast UDP 7778: "PAN_DISCOVER"
//   Hub    → unicast UDP back:   "PAN_HERE:{"name":"...","port":7777,"version":"...","hostname":"..."}"

import dgram from 'dgram';
import os from 'os';

const DISCOVERY_PORT = 7778;
const DISCOVER_MSG   = 'PAN_DISCOVER';
const REPLY_PREFIX   = 'PAN_HERE:';

let _sock = null;

/**
 * Start the UDP discovery responder.
 * @param {number} hubPort - The HTTP port PAN is listening on (7777 or 7781)
 * @param {string} version - PAN version string
 * @param {string} [hubName] - Display name of this hub (defaults to hostname)
 */
export function startDiscovery(hubPort = 7777, version = '0.3.1', hubName = null) {
  if (_sock) stopDiscovery();

  _sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  _sock.on('error', (err) => {
    // Port in use by another PAN instance — log and give up quietly
    console.warn(`[Discovery] UDP bind error: ${err.message}`);
    _sock = null;
  });

  _sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8').trim();
    if (text !== DISCOVER_MSG) return;

    const name = hubName || os.hostname();
    const payload = JSON.stringify({
      name,
      hostname: os.hostname(),
      port: hubPort,
      version,
    });
    const reply = Buffer.from(REPLY_PREFIX + payload, 'utf8');

    // Reply directly to the sender (not broadcast) so multiple hubs don't stomp
    _sock.send(reply, 0, reply.length, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn(`[Discovery] Reply error: ${err.message}`);
      else console.log(`[Discovery] Replied to ${rinfo.address}:${rinfo.port} → ${payload}`);
    });
  });

  _sock.on('listening', () => {
    const addr = _sock.address();
    _sock.setBroadcast(true);
    console.log(`[Discovery] UDP responder listening on port ${addr.port}`);
  });

  _sock.bind(DISCOVERY_PORT);
}

/** Stop the UDP discovery responder. */
export function stopDiscovery() {
  if (_sock) {
    try { _sock.close(); } catch {}
    _sock = null;
  }
}
