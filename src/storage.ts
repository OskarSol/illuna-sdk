import type { Elements, Value } from "./index.js";

export interface Scope { appId: string; userId: string }
export interface StoredState { values: Record<string, Value>; revision: number }
export type MaybePromise<T> = T | Promise<T>;
/** commit must atomically compare the revision and apply the entire batch. null removes an override. */
export interface Storage {
  initialize(appId: string, elements: Elements): MaybePromise<void>;
  read(scope: Scope): MaybePromise<StoredState>;
  commit(scope: Scope, expectedRevision: number, changes: Record<string, Value | null>): MaybePromise<StoredState>;
  close(): MaybePromise<void>;
}
