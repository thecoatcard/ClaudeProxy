"use client";
import { useState, useEffect } from 'react';

export default function KeysPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  
  const [geminiKeys, setGeminiKeys] = useState<any[]>([]);
  const [newGKey, setNewGKey] = useState("");

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

  const login = async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      setIsAuthenticated(true);
      fetchKeys();
    } else {
      alert("Invalid credentials");
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setIsAuthenticated(false);
    setGeminiKeys([]);
  };

  const fetchKeys = async () => {
    const res1 = await fetch('/api/admin/keys', { cache: 'no-store' });
    if (res1.ok) {
      const data1 = await res1.json();
      setGeminiKeys(data1.keys || []);
    }
  };

  const addGeminiKey = async () => {
    await fetch('/api/admin/keys', { method: 'POST', body: JSON.stringify({ key: newGKey }), headers: { 'Content-Type': 'application/json' } });
    setNewGKey("");
    fetchKeys();
  };

  const deleteGKey = async (id: string) => {
    if (confirm("Are you sure you want to completely delete this Gemini API Key?")) {
      await fetch(`/api/admin/keys?id=${id}`, { method: 'DELETE' });
      fetchKeys();
    }
  };

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: '400px', margin: '4rem auto' }} className="card">
        <h2 style={{ marginBottom: '1rem' }}>Admin Login</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input type="email" placeholder="Email" className="input" value={email} onChange={e => setEmail(e.target.value)} />
          <input type="password" placeholder="Password" className="input" value={password} onChange={e => setPassword(e.target.value)} />
          <button className="btn" onClick={login}>Login</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Provider Keys Management</h1>
        <button className="btn" onClick={logout}>Logout</button>
      </div>
      
      <div className="card">
        <h2 className="card-title">Gemini Provider Keys</h2>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <input type="text" placeholder="New Gemini API Key" className="input" value={newGKey} onChange={e => setNewGKey(e.target.value)} />
          <button className="btn" onClick={addGeminiKey}>Add Key</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>Key</th><th>Status</th><th>Failures</th><th>Actions</th></tr></thead>
          <tbody>
            {geminiKeys.map(k => (
              <tr key={k.id}>
                <td style={{ fontFamily: 'monospace' }}>{k.id}</td>
                <td style={{ fontFamily: 'monospace' }}>{k.key.substring(0,8)}...</td>
                <td><span className={`badge badge-${k.status}`}>{k.status}</span></td>
                <td>{k.failure_count || 0}</td>
                <td><button className="btn btn-danger" onClick={() => deleteGKey(k.id)}>Delete</button></td>
              </tr>
            ))}
            {geminiKeys.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>No Provider API keys found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
