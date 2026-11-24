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

import SupabasePersistenceManager from '../../../src/classes/persistence/supabase-persistence-manager';
import type { SupabaseClient as SupabaseJsClient } from '@supabase/supabase-js';

const VALID_XML =
  '<map name="101" version="tango"><topic central="true" text="Central Idea" id="1"/></map>';
const INVALID_XML = '<map name="101" version="tango"><topic central="true" text="Unclosed';

type MockAuth = {
  onAuthStateChange: jest.Mock;
  getSession: jest.Mock;
};

type MockSupabase = {
  auth: MockAuth;
  from: jest.Mock;
};

describe('SupabasePersistenceManager', () => {
  let mockSupabase: MockSupabase;
  let mockAuth: MockAuth;
  let onSessionExpiredMock: jest.Mock;

  beforeEach(() => {
    onSessionExpiredMock = jest.fn();
    mockAuth = {
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      getSession: jest.fn().mockResolvedValue({ data: { session: {} }, error: null }),
    };

    mockSupabase = {
      auth: mockAuth,
      from: jest.fn(),
    };
  });

  describe('constructor', () => {
    it('initializes with options and sets hid', () => {
      const manager = new SupabasePersistenceManager({
        hid: 42,
        onSessionExpired: onSessionExpiredMock,
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      expect(manager.getHid()).toBe(42);
      expect(manager.getSupabaseClient()).toBe(mockSupabase);
      expect(mockAuth.onAuthStateChange).toHaveBeenCalled();
    });
  });

  describe('loadMapDom', () => {
    it('loads current map XML from public.mindmaps when hid is undefined', async () => {
      const mockSingle = jest.fn().mockResolvedValue({
        data: { xml: VALID_XML },
        error: null,
      });
      const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });

      mockSupabase.from.mockReturnValue({
        select: mockSelect,
      });

      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const doc = await manager.loadMapDom('101');

      expect(mockSupabase.from).toHaveBeenCalledWith('mindmaps');
      expect(mockSelect).toHaveBeenCalledWith('xml');
      expect(mockEq).toHaveBeenCalledWith('id', 101);
      expect(doc.querySelector('topic')?.getAttribute('text')).toBe('Central Idea');
    });

    it('loads historical revision XML from public.mindmap_history when hid is provided', async () => {
      const mockSingle = jest.fn().mockResolvedValue({
        data: { xml: VALID_XML },
        error: null,
      });
      const mockEqMindmapId = jest.fn().mockReturnValue({ single: mockSingle });
      const mockEqId = jest.fn().mockReturnValue({ eq: mockEqMindmapId });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEqId });

      mockSupabase.from.mockReturnValue({
        select: mockSelect,
      });

      const manager = new SupabasePersistenceManager({
        hid: 77,
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const doc = await manager.loadMapDom('101');

      expect(mockSupabase.from).toHaveBeenCalledWith('mindmap_history');
      expect(mockSelect).toHaveBeenCalledWith('xml');
      expect(mockEqId).toHaveBeenCalledWith('id', 77);
      expect(mockEqMindmapId).toHaveBeenCalledWith('mindmap_id', 101);
      expect(doc.querySelector('topic')?.getAttribute('text')).toBe('Central Idea');
    });

    it('throws error if mapId is not a valid number', async () => {
      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      await expect(manager.loadMapDom('invalid-id')).rejects.toThrow('Invalid map ID: invalid-id');
    });

    it('triggers session expired on auth error from Supabase query', async () => {
      const mockSingle = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'JWT expired', status: 401, code: 'PGRST301' },
      });
      const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });

      mockSupabase.from.mockReturnValue({
        select: mockSelect,
      });

      const manager = new SupabasePersistenceManager({
        onSessionExpired: onSessionExpiredMock,
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const errorHandler = jest.fn();
      manager.addErrorHandler(errorHandler);

      await expect(manager.loadMapDom('101')).rejects.toThrow('JWT expired');
      expect(onSessionExpiredMock).toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'auth', severity: 'FATAL' }),
      );
    });

    it('throws error if xml contains parsing errors', async () => {
      const mockSingle = jest.fn().mockResolvedValue({
        data: { xml: INVALID_XML },
        error: null,
      });
      const mockEq = jest.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });

      mockSupabase.from.mockReturnValue({
        select: mockSelect,
      });

      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      await expect(manager.loadMapDom('101')).rejects.toThrow('Failed to parse mindmap XML');
    });
  });

  describe('saveMapXml', () => {
    it('updates public.mindmaps and invokes onSuccess without saving history on autosave', async () => {
      const mockEq = jest.fn().mockResolvedValue({ error: null });
      const mockUpdate = jest.fn().mockReturnValue({ eq: mockEq });
      mockSupabase.from.mockReturnValue({ update: mockUpdate });

      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const dom = new DOMParser().parseFromString(VALID_XML, 'text/xml');
      const onSuccess = jest.fn();
      const onError = jest.fn();

      manager.saveMapXml('101', dom, undefined, false, { onSuccess, onError });

      // Wait for async queue
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSupabase.from).toHaveBeenCalledWith('mindmaps');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          xml: expect.stringContaining('<topic central="true" text="Central Idea" id="1"/>'),
          updated_at: expect.any(String),
        }),
      );
      expect(mockEq).toHaveBeenCalledWith('id', 101);
      expect(onSuccess).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('inserts a record into public.mindmap_history when saveHistory is true', async () => {
      const mockEq = jest.fn().mockResolvedValue({ error: null });
      const mockUpdate = jest.fn().mockReturnValue({ eq: mockEq });
      const mockInsert = jest.fn().mockResolvedValue({ error: null });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'mindmaps') {
          return { update: mockUpdate };
        }
        if (table === 'mindmap_history') {
          return { insert: mockInsert };
        }
        return {};
      });

      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const dom = new DOMParser().parseFromString(VALID_XML, 'text/xml');
      const onSuccess = jest.fn();
      const onError = jest.fn();

      manager.saveMapXml('101', dom, undefined, true, { onSuccess, onError });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSupabase.from).toHaveBeenCalledWith('mindmaps');
      expect(mockSupabase.from).toHaveBeenCalledWith('mindmap_history');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          mindmap_id: 101,
          xml: expect.stringContaining('Central Idea'),
        }),
      );
      expect(onSuccess).toHaveBeenCalled();
    });

    it('triggers auth error and onError when update fails due to expired session', async () => {
      const mockEq = jest.fn().mockResolvedValue({
        error: { message: 'JWT expired', status: 401, code: 'PGRST301' },
      });
      const mockUpdate = jest.fn().mockReturnValue({ eq: mockEq });
      mockSupabase.from.mockReturnValue({ update: mockUpdate });

      const manager = new SupabasePersistenceManager({
        onSessionExpired: onSessionExpiredMock,
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      const dom = new DOMParser().parseFromString(VALID_XML, 'text/xml');
      const onSuccess = jest.fn();
      const onError = jest.fn();

      manager.saveMapXml('101', dom, undefined, false, { onSuccess, onError });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(onSessionExpiredMock).toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'auth', severity: 'FATAL' }),
      );
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('discardChanges and unlockMap', () => {
    it('resolves cleanly without error', async () => {
      const manager = new SupabasePersistenceManager({
        supabase: mockSupabase as unknown as SupabaseJsClient,
      });

      await expect(manager.discardChanges('101')).resolves.toBeUndefined();
      await expect(manager.unlockMap('101')).resolves.toBeUndefined();
    });
  });
});
