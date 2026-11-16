// Thin re-export of store.history (§2).
// All history operations (open, openHistory, record, update, get, list, thread, findBy, importExisting) are async.
import {store} from './store/index.mjs';
import {splitStyle, creativeMeta} from './store/file.mjs';

export const open = (...args) => store.history.open(...args);
export const openHistory = (...args) => store.history.open(...args);
export const record = (...args) => store.history.record(...args);
export const update = (...args) => store.history.update(...args);
export const get = (...args) => store.history.get(...args);
export const list = (...args) => store.history.list(...args);
export const thread = (...args) => store.history.thread(...args);
export const findBy = (...args) => store.history.findBy(...args);
export const importExisting = (...args) => store.history.importExisting(...args);

export {splitStyle, creativeMeta};
