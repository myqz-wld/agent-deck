/** Current sessions repository facade, composed from focused persistence modules. */

import * as coreCrud from './core-crud';
import { setArchived, SessionRowMissingError } from './archive';
import * as lifecycle from './lifecycle';
import * as history from './history';
import * as visibility from './visibility';
import * as contextUsage from './context-usage';
import { setPinned, SessionPinStateError } from './pinning';
import { rename } from './rename';
import * as spawnChain from './spawn-chain';
import * as presentation from './presentation';

// Keep the implementation's internal name out of the public facade.
const { _delete, ...coreRest } = coreCrud;

export const sessionRepo = {
  ...coreRest,
  delete: _delete,
  setArchived,
  setPinned,
  ...lifecycle,
  ...history,
  ...visibility,
  ...contextUsage,
  rename,
  ...spawnChain,
  ...presentation,
};

export { SessionRowMissingError, SessionPinStateError };
