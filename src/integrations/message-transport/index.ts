/**
 * `src/integrations/message-transport` — the one way a proof pack leaves this machine
 * (audit row 42).
 *
 * A real WhatsApp Cloud API adapter when credentials are present; a transport that refuses by
 * name when they are not. Never a transport that quietly succeeds: a delivery record claiming
 * a message arrived when none was sent is the failure this module exists to prevent.
 */

export * from './port.js';
export * from './unconfigured.js';
export * from './whatsapp-cloud.js';
