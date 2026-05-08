import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api } from './client';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('api client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('listWorkspaces sends GET request', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve([]) });
    const result = await api.listWorkspaces();
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/workspaces',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
    );
  });

  it('createWorkspace sends POST with name', async () => {
    const ws = { id: '1', name: 'Test' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve(ws) });
    const result = await api.createWorkspace('Test');
    expect(result).toEqual(ws);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/workspaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Test' }),
      })
    );
  });

  it('deleteWorkspace sends DELETE', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
    await api.deleteWorkspace('ws-1');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('createSession sends POST to workspace endpoint', async () => {
    const sess = { id: 's-1', title: 'Dev' };
    mockFetch.mockResolvedValue({ json: () => Promise.resolve(sess) });
    const result = await api.createSession('ws-1', 'Dev');
    expect(result).toEqual(sess);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/ws-1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Dev' }),
      })
    );
  });

  it('updateSession sends PATCH', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ id: 's-1', title: 'New' }) });
    await api.updateSession('s-1', 'New');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/sessions/s-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'New' }),
      })
    );
  });

  it('deleteSession sends DELETE', async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true }) });
    await api.deleteSession('s-1');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/sessions/s-1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
