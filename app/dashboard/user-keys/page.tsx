"use client";
import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function UserKeysPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userKeys, setUserKeys] = useState<any[]>([]);
  const [newUKeyName, setNewUKeyName] = useState("");
  const [editingUKey, setEditingUKey] = useState<string | null>(null);
  const [editUKeyName, setEditUKeyName] = useState("");

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      setIsAuthenticated(true);
      fetchKeys();
    }
  };

  const fetchKeys = async () => {
    const res = await fetch('/api/admin/user-keys', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      // Filter out revoked keys here so they don't appear in the list
      const activeKeys = (data.userKeys || []).filter((k: any) => k.status !== 'revoked');
      setUserKeys(activeKeys);
    }
  };

  const addUserKey = async () => {
    await fetch('/api/admin/user-keys', { method: 'POST', body: JSON.stringify({ name: newUKeyName }), headers: { 'Content-Type': 'application/json' } });
    setNewUKeyName("");
    fetchKeys();
  };

  const deleteUKey = async (id: string) => {
    if (confirm("Are you sure you want to revoke this user key? It will be removed from this list.")) {
      await fetch(`/api/admin/user-keys?id=${id}`, { method: 'DELETE' });
      fetchKeys();
    }
  };

  const saveUKeyName = async (id: string) => {
    await fetch('/api/admin/user-keys', { 
      method: 'PUT', 
      body: JSON.stringify({ id, name: editUKeyName }), 
      headers: { 'Content-Type': 'application/json' } 
    });
    setEditingUKey(null);
    fetchKeys();
  };

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: '400px', margin: '4rem auto', textAlign: 'center' }}>
        <p>You must be logged in to view this page.</p>
        <Link href="/dashboard/keys"><button className="btn" style={{ marginTop: '1rem' }}>Go to Login</button></Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>User Gateway Keys</h1>
      </div>

      <div className="card">
        <h2 className="card-title">Manage Access Tokens</h2>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <input type="text" placeholder="User Name / Identifier" className="input" value={newUKeyName} onChange={e => setNewUKeyName(e.target.value)} />
          <button className="btn" onClick={addUserKey}>Create User Key</button>
        </div>
        <table>
          <thead><tr><th>Token</th><th>Name</th><th>Status</th><th>Usage</th><th>Actions</th></tr></thead>
          <tbody>
            {userKeys.map(k => (
              <tr key={k.token}>
                <td style={{ fontFamily: 'monospace' }}>{k.token}</td>
                <td>
                  {editingUKey === k.token ? (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input type="text" className="input" value={editUKeyName} onChange={e => setEditUKeyName(e.target.value)} style={{ padding: '0.2rem', minWidth: '100px' }} />
                      <button className="btn" onClick={() => saveUKeyName(k.token)} style={{ padding: '0.2rem 0.5rem' }}>Save</button>
                      <button className="btn btn-danger" onClick={() => setEditingUKey(null)} style={{ padding: '0.2rem 0.5rem' }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {k.name}
                      <button className="btn" style={{ padding: '0.1rem 0.4rem', fontSize: '0.8rem', background: 'rgba(255,255,255,0.1)', color: '#fff', boxShadow: 'none' }} onClick={() => { setEditingUKey(k.token); setEditUKeyName(k.name); }}>Edit</button>
                    </div>
                  )}
                </td>
                <td><span className={`badge badge-${k.status}`}>{k.status}</span></td>
                <td>{k.usage_count || 0}</td>
                <td>
                  <button className="btn btn-danger" onClick={() => deleteUKey(k.token)}>Revoke</button>
                </td>
              </tr>
            ))}
            {userKeys.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No active user keys found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
