"use client";
import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function ModelsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [models, setModels] = useState<any>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      setIsAuthenticated(true);
      fetchModels();
    }
  };

  const fetchModels = async () => {
    const res = await fetch('/api/admin/models', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.models) setModels(data.models);
    }
  };

  const saveModels = async () => {
    await fetch('/api/admin/models', { method: 'POST', body: JSON.stringify({ models }), headers: { 'Content-Type': 'application/json' } });
    alert("Saved");
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
        <h1>Model Routing</h1>
        <button className="btn" onClick={fetchModels}>Refresh Mappings</button>
      </div>

      {models && (
        <div className="card">
          <h2 className="card-title">Routing Map</h2>
          <textarea 
            className="input" 
            style={{ height: '300px', fontFamily: 'monospace', marginBottom: '1rem' }}
            value={JSON.stringify(models, null, 2)}
            onChange={e => {
              try { setModels(JSON.parse(e.target.value)); } catch(err) {}
            }}
          />
          <button className="btn" onClick={saveModels}>Save JSON Mapping</button>
        </div>
      )}
    </div>
  );
}
