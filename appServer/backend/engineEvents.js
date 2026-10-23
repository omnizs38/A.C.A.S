import { EventEmitter } from 'node:events';

// Local consumers use the same engine lifecycle as the legacy WebSocket GUI.
// No socket needs to be opened to receive UCI lines in desktop mode.
export const engineEvents = new EventEmitter();
