/*
 *    Copyright [2007-2025] [wisemapping]
 *
 *   Licensed under WiseMapping Public License, Version 1.0 (the "License").
 *   It is basically the Apache License, Version 2.0 (the "License") plus the
 *   "powered by wisemapping" text requirement on every single page;
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the license at
 *
 *       https://github.com/wisemapping/wisemapping-open-source/blob/main/LICENSE.md
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 */

import { PersistenceManager } from '@wisemapping/mindplot';
import type { PersistenceError, SaveEvents, SaveOptions } from '@wisemapping/mindplot';
import { createClient, SupabaseClient as SupabaseJsClient } from '@supabase/supabase-js';
import AppConfig from '../app-config';
import SupabaseClient from '../client/supabase-client';
import { appLogger as log } from '../../utils/logger';

export type SupabasePersistenceManagerOptions = {
  hid?: number | undefined;
  onSessionExpired?: (() => void) | undefined;
  supabase?: SupabaseJsClient | undefined;
};

type PendingSave = {
  mapId: string;
  xmlString: string;
  saveHistory: boolean;
  urgent: boolean;
  events: SaveEvents[];
};

export default class SupabasePersistenceManager extends PersistenceManager {
  private hid?: number | undefined;
  private onSessionExpired?: (() => void) | undefined;
  private supabase: SupabaseJsClient;

  private _saveInFlight = false;
  private _pendingSaves = new Map<string, PendingSave>();

  constructor(options?: SupabasePersistenceManagerOptions) {
    super();
    if (options?.hid !== undefined) {
      this.hid = options.hid;
    }
    if (options?.onSessionExpired !== undefined) {
      this.onSessionExpired = options.onSessionExpired;
    }

    if (options?.supabase) {
      this.supabase = options.supabase;
    } else {
      let clientInstance: unknown;
      try {
        clientInstance = AppConfig.getClient();
      } catch (e) {
        log.warn('Could not retrieve client from AppConfig:', e);
      }

      if (
        clientInstance &&
        typeof (clientInstance as SupabaseClient).getSupabaseClient === 'function'
      ) {
        this.supabase = (clientInstance as SupabaseClient).getSupabaseClient();
      } else {
        const url = AppConfig.getSupabaseUrl();
        const anonKey = AppConfig.getSupabaseAnonKey();
        if (!url || !anonKey) {
          throw new Error(
            'Supabase client could not be initialized: missing Supabase URL or Anon Key',
          );
        }
        this.supabase = createClient(url, anonKey);
      }
    }

    if (this.onSessionExpired) {
      this.supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !session)) {
          this._handleAuthError();
        }
      });
    }
  }

  getSupabaseClient(): SupabaseJsClient {
    return this.supabase;
  }

  getHid(): number | undefined {
    return this.hid;
  }

  private _isAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const err = error as Record<string, unknown>;
    const status = typeof err['status'] === 'number' ? err['status'] : undefined;
    const statusCode = typeof err['statusCode'] === 'number' ? err['statusCode'] : undefined;
    if (status === 401 || status === 403 || statusCode === 401 || statusCode === 403) {
      return true;
    }
    const msg = typeof err['message'] === 'string' ? err['message'].toLowerCase() : '';
    const code = typeof err['code'] === 'string' ? err['code'].toLowerCase() : '';
    return (
      code === 'pgrst301' ||
      code === '42501' ||
      msg.includes('jwt') ||
      msg.includes('token') ||
      msg.includes('session expired') ||
      msg.includes('unauthorized') ||
      msg.includes('not authenticated') ||
      msg.includes('permission denied')
    );
  }

  private _handleAuthError(): void {
    const error: PersistenceError = {
      severity: 'FATAL',
      errorType: 'auth',
      message: 'Session expired',
    };
    this.triggerError(error);
    if (this.onSessionExpired) {
      this.onSessionExpired();
    }
  }

  async loadMapDom(mapId: string): Promise<Document> {
    const numericId = Number.parseInt(mapId, 10);
    if (Number.isNaN(numericId)) {
      throw new Error(`Invalid map ID: ${mapId}`);
    }

    let xml: string | undefined;

    if (this.hid !== undefined) {
      const { data, error } = await this.supabase
        .from('mindmap_history')
        .select('xml')
        .eq('id', this.hid)
        .eq('mindmap_id', numericId)
        .single();

      if (error) {
        if (this._isAuthError(error)) {
          this._handleAuthError();
        }
        throw new Error(
          `Failed to load mindmap revision ${this.hid} for map ${mapId}: ${error.message}`,
        );
      }
      xml = data?.xml;
    } else {
      const { data, error } = await this.supabase
        .from('mindmaps')
        .select('xml')
        .eq('id', numericId)
        .single();

      if (error) {
        if (this._isAuthError(error)) {
          this._handleAuthError();
        }
        throw new Error(`Failed to load mindmap ${mapId}: ${error.message}`);
      }
      xml = data?.xml;
    }

    if (!xml) {
      throw new Error(`Mindmap XML content is empty for mapId: ${mapId}`);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      throw new Error(`Failed to parse mindmap XML for mapId ${mapId}: ${parserError.textContent}`);
    }

    return doc;
  }

  saveMapXml(
    mapId: string,
    mapXml: Document,
    _pref?: string,
    saveHistory?: boolean,
    events?: SaveEvents,
    options?: SaveOptions,
  ): void {
    const urgent = Boolean(options?.urgent);
    let xmlString: string;
    try {
      xmlString = new XMLSerializer().serializeToString(mapXml);
    } catch {
      const error: PersistenceError = {
        severity: 'SEVERE',
        errorType: 'unexpected',
        message: 'Failed to serialize mindmap XML',
      };
      this.triggerError(error);
      events?.onError(error);
      return;
    }

    const pending = this._pendingSaves.get(mapId);
    if (pending) {
      pending.xmlString = xmlString;
      pending.saveHistory = pending.saveHistory || Boolean(saveHistory);
      pending.urgent = pending.urgent || urgent;
      if (events) {
        pending.events.push(events);
      }
    } else {
      this._pendingSaves.set(mapId, {
        mapId,
        xmlString,
        saveHistory: Boolean(saveHistory),
        urgent,
        events: events ? [events] : [],
      });
    }

    void this._processNextSave();
  }

  private async _processNextSave(): Promise<void> {
    if (this._saveInFlight) {
      return;
    }

    const pendingEntries = Array.from(this._pendingSaves.values());
    const next = pendingEntries.find((p) => p.urgent) ?? pendingEntries[0];
    if (!next) {
      return;
    }

    this._pendingSaves.delete(next.mapId);
    this._saveInFlight = true;

    const { mapId, xmlString, saveHistory, events } = next;
    const numericId = Number.parseInt(mapId, 10);

    try {
      if (Number.isNaN(numericId)) {
        throw new Error(`Invalid map ID: ${mapId}`);
      }

      // 1. Update public.mindmaps
      const { error: updateError } = await this.supabase
        .from('mindmaps')
        .update({
          xml: xmlString,
          updated_at: new Date().toISOString(),
        })
        .eq('id', numericId);

      if (updateError) {
        if (this._isAuthError(updateError)) {
          this._handleAuthError();
          const persistenceError: PersistenceError = {
            severity: 'FATAL',
            errorType: 'auth',
            message: 'Session expired',
          };
          events.forEach((e) => e.onError(persistenceError));
          return;
        }
        throw new Error(`Failed to update mindmap ${mapId}: ${updateError.message}`);
      }

      // 2. When saveHistory is true, insert a new record into public.mindmap_history
      if (saveHistory) {
        const { error: historyError } = await this.supabase.from('mindmap_history').insert({
          mindmap_id: numericId,
          xml: xmlString,
        });

        if (historyError) {
          if (this._isAuthError(historyError)) {
            this._handleAuthError();
            const persistenceError: PersistenceError = {
              severity: 'FATAL',
              errorType: 'auth',
              message: 'Session expired',
            };
            events.forEach((e) => e.onError(persistenceError));
            return;
          }
          log.warn(`Failed to insert mindmap history for map ${mapId}:`, historyError);
        }
      }

      // Notify success to all subscribers
      events.forEach((e) => e.onSuccess());
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : 'Save could not be completed';
      const persistenceError: PersistenceError = {
        severity: 'SEVERE',
        errorType: 'unexpected',
        message: errorMsg,
      };
      this.triggerError(persistenceError);
      events.forEach((e) => e.onError(persistenceError));
    } finally {
      this._saveInFlight = false;
      if (this._pendingSaves.size > 0) {
        void this._processNextSave();
      }
    }
  }

  async discardChanges(_mapId: string): Promise<void> {
    return Promise.resolve();
  }

  async unlockMap(_mapId: string): Promise<void> {
    return Promise.resolve();
  }
}
