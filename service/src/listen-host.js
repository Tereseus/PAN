// Which address PAN's ports listen on (the Super-Carrier's 7777, the Carrier's and the
// Craft's inner ones). One rule for all three, so they can't disagree.
//
// This computer only, unless someone says otherwise. Whoever reaches these ports is
// treated as the owner (server.js), so open to the network means open to everyone on the
// Wi-Fi. Other devices come in through PAN Link, which knows each device by its key
// (pan-link/README.md).
//
// PAN_HOST=0.0.0.0 opens the ports to the network: for a hub whose devices are not all on
// the link yet, and for a dev PAN that a phone on the same Wi-Fi tests against.

export const THIS_COMPUTER = '127.0.0.1';

export function listenHost(env = process.env) {
  const asked = String(env.PAN_HOST || '').trim();
  return asked || THIS_COMPUTER;
}

/** For the log line at start: says in plain words who can reach the port. */
export function listenWords(host) {
  return host === THIS_COMPUTER || host === '::1' || host === 'localhost'
    ? 'this computer only (other devices come in through PAN Link)'
    : `the network, on ${host}: anyone who reaches it is treated as the owner`;
}
