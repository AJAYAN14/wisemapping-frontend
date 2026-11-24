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

import { createClient, SupabaseClient as SupabaseJsClient } from '@supabase/supabase-js';
import Client, {
  AccountInfo,
  AuthenticationType,
  BasicMapInfo,
  ChangeHistory,
  ErrorInfo,
  ForgotPasswordResult,
  ImportMapInfo,
  JwtAuth,
  Label,
  LoginErrorInfo,
  MapInfo,
  MapMetadata,
  NewUser,
  Oauth2CallbackResult,
  Permission,
  Role,
} from '..';
import { Locale, LocaleCode, Locales, localeFromStr } from '../../app-i18n';
import JwtTokenConfig from '../../jwt-token-config';
import { setAnalyticsUserEmail, clearAnalyticsUserId } from '../../../utils/analytics';
import { appLogger as log } from '../../../utils/logger';

export default class SupabaseClient implements Client {
  private supabase: SupabaseJsClient;
  private _onSessionExpired?: () => void;

  constructor(supabaseUrl: string, supabaseAnonKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseAnonKey);

    this.supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !session)) {
        if (this._onSessionExpired) {
          this._onSessionExpired();
        }
      }
    });
  }

  getSupabaseClient(): SupabaseJsClient {
    return this.supabase;
  }

  onSessionExpired(callback?: () => void): (() => void) | undefined {
    if (callback) {
      this._onSessionExpired = callback;
    }
    return this._onSessionExpired;
  }

  private sessionExpired(): void {
    if (this._onSessionExpired) {
      this._onSessionExpired();
    }
  }

  async login(model: JwtAuth): Promise<void> {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email: model.email,
      password: model.password,
    });

    if (error || !data.session) {
      const errorInfo: LoginErrorInfo = {
        code: 1,
        msg: error?.message || 'Invalid login credentials',
        isAuth: true,
        status: error?.status || 401,
      };
      throw errorInfo;
    }

    if (data.session.access_token) {
      JwtTokenConfig.storeToken(data.session.access_token);
    }

    try {
      setAnalyticsUserEmail(data.user?.email || model.email);
    } catch (e) {
      log.warn('Failed to set analytics user email after login:', e);
    }
  }

  async logout(): Promise<void> {
    JwtTokenConfig.removeToken();
    clearAnalyticsUserId();
    try {
      await this.supabase.auth.signOut();
    } catch (e) {
      log.error('Error logging out from Supabase', e);
    }
  }

  async registerNewUser(user: NewUser): Promise<void> {
    const { data, error } = await this.supabase.auth.signUp({
      email: user.email,
      password: user.password,
      options: {
        data: {
          firstname: user.firstname,
          lastname: user.lastname,
        },
      },
    });

    if (error) {
      const errorInfo: ErrorInfo = {
        msg: error.message,
        status: error.status || 400,
      };
      if (error.message.toLowerCase().includes('email')) {
        errorInfo.fields = { email: error.message };
      } else if (error.message.toLowerCase().includes('password')) {
        errorInfo.fields = { password: error.message };
      }
      throw errorInfo;
    }

    if (data.session?.access_token) {
      JwtTokenConfig.storeToken(data.session.access_token);
    }
  }

  async fetchAccountInfo(): Promise<AccountInfo> {
    const { data, error } = await this.supabase.auth.getUser();

    if (error || !data.user) {
      const errorInfo: ErrorInfo = {
        isAuth: true,
        msg: 'User not authenticated',
        status: 401,
      };
      throw errorInfo;
    }

    const userMetadata = (data.user.user_metadata || {}) as Record<string, unknown>;
    const firstname = typeof userMetadata['firstname'] === 'string' ? userMetadata['firstname'] : '';
    const lastname = typeof userMetadata['lastname'] === 'string' ? userMetadata['lastname'] : '';
    const email = data.user.email || '';

    let accountLocale: Locale | undefined;
    const rawLocale = userMetadata['locale'];
    if (typeof rawLocale === 'string') {
      try {
        accountLocale = localeFromStr(rawLocale);
      } catch {
        accountLocale = Locales.EN;
      }
    }

    return {
      firstname,
      lastname,
      email,
      locale: accountLocale,
      authenticationType: AuthenticationType.DATABASE,
      isAdmin: false,
    };
  }

  async fetchAllMaps(): Promise<MapInfo[]> {
    const { data, error } = await this.supabase
      .from('mindmaps')
      .select(
        `
        id,
        title,
        description,
        starred,
        created_at,
        updated_at,
        r_label_mindmap (
          label_id,
          mindmap_labels (
            id,
            title,
            color
          )
        )
      `,
      )
      .order('updated_at', { ascending: false });

    if (error) {
      if (error.code === 'PGRST301' || error.message.includes('JWT') || error.message.includes('auth')) {
        this.sessionExpired();
        throw { isAuth: true, msg: error.message, status: 401 };
      }
      throw { msg: error.message, status: 500 };
    }

    const { data: userData } = await this.supabase.auth.getUser();
    const userEmail = userData?.user?.email || 'me';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data || []).map((row: any) => {
      const labels: Label[] = Array.isArray(row.r_label_mindmap)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? row.r_label_mindmap
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((rel: any) => {
              const l = rel.mindmap_labels;
              if (!l) return null;
              return {
                id: Number(l.id),
                title: l.title,
                color: l.color,
              };
            })
            .filter((l: Label | null): l is Label => l !== null)
        : [];

      return {
        id: Number(row.id),
        starred: Boolean(row.starred),
        title: row.title,
        labels,
        createdBy: userEmail,
        creationTime: row.created_at,
        lastModificationBy: userEmail,
        lastModificationTime: row.updated_at,
        description: row.description || '',
        public: false,
        role: 'owner' as Role,
      };
    });
  }

  async fetchMapMetadata(id: number, includeXml = false): Promise<MapMetadata> {
    const query = includeXml
      ? this.supabase
          .from('mindmaps')
          .select('id, title, description, starred, created_at, updated_at, xml')
          .eq('id', id)
          .single()
      : this.supabase
          .from('mindmaps')
          .select('id, title, description, starred, created_at, updated_at')
          .eq('id', id)
          .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error }: { data: any; error: any } = await query;

    if (error || !data) {
      const errorInfo: ErrorInfo = {
        msg: error?.message || `Mindmap ${id} not found`,
        status: 404,
      };
      throw errorInfo;
    }

    const { data: userData } = await this.supabase.auth.getUser();
    const userEmail = userData?.user?.email || 'me';

    const metadata: MapMetadata = {
      id: Number(data.id),
      title: data.title,
      description: data.description || '',
      creatorFullName: userEmail,
      createdBy: userEmail,
      creationTime: data.created_at,
      lastModificationBy: userEmail,
      lastModificationTime: data.updated_at,
      starred: Boolean(data.starred),
      isLocked: false,
      jsonProps: '{"zoom":0.8}',
      role: 'owner',
      public: false,
    };

    if (includeXml && typeof data.xml === 'string') {
      metadata.xml = data.xml;
    }

    return metadata;
  }

  async fetchMapInfo(id: number): Promise<MapInfo> {
    const maps = await this.fetchAllMaps();
    const map = maps.find((m) => m.id === id);
    if (!map) {
      throw { msg: `Map with id ${id} could not be found. Please, refresh the page.`, status: 404 };
    }
    return map;
  }

  async createMap(model: BasicMapInfo): Promise<number> {
    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const title = model.title?.trim() || 'New Mindmap';
    const defaultXml = `<map version="tango" theme="prism"><topic central="true" text="${escapeXml(
      title,
    )}" id="1"/></map>`;

    const { data, error } = await this.supabase
      .from('mindmaps')
      .insert({
        title,
        description: model.description || null,
        xml: defaultXml,
        starred: false,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw { msg: error?.message || 'Failed to create mindmap', status: 500 };
    }

    const mapId = Number(data.id);

    try {
      await this.supabase.from('mindmap_history').insert({
        mindmap_id: mapId,
        xml: defaultXml,
      });
    } catch (e) {
      log.warn('Failed to record initial history entry for map', mapId, e);
    }

    return mapId;
  }

  async renameMap(id: number, changes: Partial<BasicMapInfo>): Promise<void> {
    const updatePayload: { title?: string; description?: string } = {};
    if (changes.title !== undefined) {
      updatePayload.title = changes.title;
    }
    if (changes.description !== undefined) {
      updatePayload.description = changes.description;
    }

    if (Object.keys(updatePayload).length === 0) {
      return;
    }

    const { error } = await this.supabase.from('mindmaps').update(updatePayload).eq('id', id);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async deleteMap(id: number): Promise<void> {
    const { error } = await this.supabase.from('mindmaps').delete().eq('id', id);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async deleteMaps(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const { error } = await this.supabase.from('mindmaps').delete().in('id', ids);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async duplicateMap(id: number, basicInfo: BasicMapInfo): Promise<number> {
    const { data: source, error: fetchError } = await this.supabase
      .from('mindmaps')
      .select('xml, description')
      .eq('id', id)
      .single();

    if (fetchError || !source) {
      throw { msg: fetchError?.message || 'Source mindmap not found', status: 404 };
    }

    const newTitle = basicInfo.title?.trim() || 'Copy of Mindmap';
    const newDescription =
      basicInfo.description !== undefined ? basicInfo.description : source.description;

    const { data: newMap, error: insertError } = await this.supabase
      .from('mindmaps')
      .insert({
        title: newTitle,
        description: newDescription,
        xml: source.xml,
        starred: false,
      })
      .select('id')
      .single();

    if (insertError || !newMap) {
      throw { msg: insertError?.message || 'Failed to duplicate mindmap', status: 500 };
    }

    const newMapId = Number(newMap.id);

    try {
      await this.supabase.from('mindmap_history').insert({
        mindmap_id: newMapId,
        xml: source.xml,
      });
    } catch (e) {
      log.warn('Failed to record initial history for duplicated map', newMapId, e);
    }

    return newMapId;
  }

  async importMap(model: ImportMapInfo): Promise<number> {
    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    let xmlStr: string;
    if (typeof model.content === 'string') {
      xmlStr = model.content;
    } else if (model.content instanceof ArrayBuffer) {
      xmlStr = new TextDecoder('utf-8').decode(model.content);
    } else {
      xmlStr = `<map version="tango" theme="prism"><topic central="true" text="${escapeXml(
        model.title,
      )}" id="1"/></map>`;
    }

    const { data, error } = await this.supabase
      .from('mindmaps')
      .insert({
        title: model.title,
        description: model.description || null,
        xml: xmlStr,
        starred: false,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw { msg: error?.message || 'Failed to import mindmap', status: 500 };
    }

    const mapId = Number(data.id);

    try {
      await this.supabase.from('mindmap_history').insert({
        mindmap_id: mapId,
        xml: xmlStr,
      });
    } catch (e) {
      log.warn('Failed to record initial history for imported map', mapId, e);
    }

    return mapId;
  }

  async updateStarred(id: number, starred: boolean): Promise<void> {
    const { error } = await this.supabase.from('mindmaps').update({ starred }).eq('id', id);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async fetchLabels(): Promise<Label[]> {
    const { data, error } = await this.supabase
      .from('mindmap_labels')
      .select('id, title, color')
      .order('title', { ascending: true });

    if (error) {
      throw { msg: error.message, status: 500 };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data || []).map((l: any) => ({
      id: Number(l.id),
      title: l.title,
      color: l.color,
    }));
  }

  async createLabel(title: string, color: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('mindmap_labels')
      .insert({ title, color })
      .select('id')
      .single();

    if (error || !data) {
      throw { msg: error?.message || 'Failed to create label', status: 500 };
    }

    return Number(data.id);
  }

  async deleteLabel(id: number): Promise<void> {
    const { error } = await this.supabase.from('mindmap_labels').delete().eq('id', id);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async addLabelToMap(labelId: number, mapId: number): Promise<void> {
    const { error } = await this.supabase
      .from('r_label_mindmap')
      .insert({ label_id: labelId, mindmap_id: mapId });

    if (error) {
      if (!error.message.includes('duplicate') && !error.message.includes('unique')) {
        throw { msg: error.message, status: 500 };
      }
    }
  }

  async deleteLabelFromMap(labelId: number, mapId: number): Promise<void> {
    const { error } = await this.supabase
      .from('r_label_mindmap')
      .delete()
      .eq('label_id', labelId)
      .eq('mindmap_id', mapId);

    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async fetchHistory(id: number): Promise<ChangeHistory[]> {
    const { data, error } = await this.supabase
      .from('mindmap_history')
      .select('id, created_at')
      .eq('mindmap_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      throw { msg: error.message, status: 500 };
    }

    const { data: userData } = await this.supabase.auth.getUser();
    const userEmail = userData?.user?.email || 'User';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data || []).map((h: any) => ({
      id: Number(h.id),
      lastModificationBy: userEmail,
      lastModificationTime: h.created_at,
    }));
  }

  async revertHistory(id: number, cid: number): Promise<void> {
    const { data, error } = await this.supabase
      .from('mindmap_history')
      .select('xml')
      .eq('id', cid)
      .eq('mindmap_id', id)
      .single();

    if (error || !data) {
      throw { msg: error?.message || 'History revision not found', status: 404 };
    }

    const { error: updateError } = await this.supabase
      .from('mindmaps')
      .update({
        xml: data.xml,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) {
      throw { msg: updateError.message, status: 500 };
    }
  }

  async updateAccountLanguage(locale: LocaleCode): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({
      data: { locale },
    });
    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async updateAccountPassword(password: string): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({
      password,
    });
    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async updateAccountInfo(firstname: string, lastname: string): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({
      data: { firstname, lastname },
    });
    if (error) {
      throw { msg: error.message, status: 500 };
    }
  }

  async deleteAccount(): Promise<void> {
    await this.logout();
  }

  async updateMapToPublic(_id: number, _isPublic: boolean): Promise<void> {
    return Promise.resolve();
  }

  async fetchMapPermissions(_id: number): Promise<Permission[]> {
    return Promise.resolve([]);
  }

  async addMapPermissions(_id: number, _message: string, _permissions: Permission[]): Promise<void> {
    return Promise.resolve();
  }

  async deleteMapPermission(_id: number, _email: string): Promise<void> {
    return Promise.resolve();
  }

  async resetPassword(email: string): Promise<ForgotPasswordResult> {
    try {
      await this.supabase.auth.resetPasswordForEmail(email);
    } catch (e) {
      log.warn('Password reset request error:', e);
    }
    return { action: 'EMAIL_SENT' };
  }

  async resetPasswordFromToken(_token: string, newPassword: string): Promise<void> {
    const { error } = await this.supabase.auth.updateUser({ password: newPassword });
    if (error) throw { msg: error.message };
  }

  async activateAccount(_code: string): Promise<void> {
    return Promise.resolve();
  }

  async processGoogleCallback(_code: string): Promise<Oauth2CallbackResult> {
    return Promise.resolve({ email: '', oauthSync: false });
  }

  async processFacebookCallback(_code: string): Promise<Oauth2CallbackResult> {
    return Promise.resolve({ email: '', oauthSync: false });
  }

  async confirmAccountSync(
    email: string,
    _code?: string,
    _provider?: string,
  ): Promise<Oauth2CallbackResult> {
    return Promise.resolve({ email, oauthSync: false });
  }
}
