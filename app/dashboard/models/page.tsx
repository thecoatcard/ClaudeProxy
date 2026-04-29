"use client";
import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function ModelsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [models, setModels] = useState<Record<string, { primary: string, fallback: string[] }>>({});
  const [isEditingJson, setIsEditingJson] = useState(false);
  const [jsonValue, setJsonValue] = useState("");

  // Form state for adding/editing a route
  const [newAlias, setNewAlias] = useState("");
  const [newPrimary, setNewPrimary] = useState("");
  const [newFallbacks, setNewFallbacks] = useState("");

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
      if (data.models) {
        setModels(data.models);
        setJsonValue(JSON.stringify(data.models, null, 2));
      }
    }
  };

  const saveModels = async (updatedModels: any) => {
    const res = await fetch('/api/admin/models', { 
      method: 'POST', 
      body: JSON.stringify({ models: updatedModels }), 
      headers: { 'Content-Type': 'application/json' } 
    });
    if (res.ok) {
      alert("Mapping saved successfully.");
      fetchModels();
    } else {
      alert("Failed to save mapping.");
    }
  };

  const handleAddRoute = () => {
    if (!newAlias || !newPrimary) {
      alert("Please enter both an alias and a primary model.");
      return;
    }
    const fallbackList = newFallbacks.split(',').map(s => s.trim()).filter(Boolean);
    const updated = {
      ...models,
      [newAlias]: { primary: newPrimary, fallback: fallbackList }
    };
    setModels(updated);
    setJsonValue(JSON.stringify(updated, null, 2));
    setNewAlias("");
    setNewPrimary("");
    setNewFallbacks("");
    saveModels(updated);
  };

  const handleDeleteRoute = (alias: string) => {
    if (!confirm(`Delete routing for ${alias}?`)) return;
    const { [alias]: removed, ...rest } = models;
    setModels(rest);
    setJsonValue(JSON.stringify(rest, null, 2));
    saveModels(rest);
  };

  const handleJsonSave = () => {
    try {
      const parsed = JSON.parse(jsonValue);
      setModels(parsed);
      saveModels(parsed);
      setIsEditingJson(false);
    } catch (e) {
      alert("Invalid JSON format.");
    }
  };

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: '400px', margin: '4rem auto', textAlign: 'center' }} className="card">
        <p>Admin authentication required.</p>
        <Link href="/dashboard/keys"><button className="btn" style={{ marginTop: '1rem' }}>Go to Login</button></Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Model Routing</h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Map Anthropic model names to Gemini provider models.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
           <button className="btn" onClick={() => setIsEditingJson(!isEditingJson)}>
            {isEditingJson ? "Cancel JSON Edit" : "Edit Raw JSON"}
          </button>
          <button className="btn" onClick={fetchModels}>Refresh</button>
        </div>
      </div>

      {isEditingJson ? (
        <div className="card">
          <h2 className="card-title">JSON Editor</h2>
          <textarea 
            className="input" 
            style={{ height: '500px', fontFamily: 'monospace', marginBottom: '1rem', fontSize: '0.85rem' }}
            value={jsonValue}
            onChange={e => setJsonValue(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleJsonSave}>Save JSON Changes</button>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: '2rem' }}>
            <h2 className="card-title">Add / Update Route</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '1rem', alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.3rem' }}>Anthropic Alias (e.g. claude-3-opus)</label>
                <input type="text" className="input" value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="claude-..." />
              </div>
              <div>
                <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.3rem' }}>Primary Gemini Model</label>
                <input type="text" className="input" value={newPrimary} onChange={e => setNewPrimary(e.target.value)} placeholder="gemini-..." />
              </div>
              <div>
                <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.3rem' }}>Fallbacks (comma separated)</label>
                <input type="text" className="input" value={newFallbacks} onChange={e => setNewFallbacks(e.target.value)} placeholder="mod-1, mod-2" />
              </div>
              <button className="btn btn-primary" onClick={handleAddRoute}>Update Route</button>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title">Current Mappings</h2>
            <table>
              <thead>
                <tr>
                  <th>Anthropic Model (Alias)</th>
                  <th>Primary Gemini</th>
                  <th>Fallback Chain</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(models).sort().map(([alias, config]) => (
                  <tr key={alias}>
                    <td style={{ fontWeight: 'bold' }}>{alias}</td>
                    <td><code style={{ color: 'var(--primary)' }}>{config.primary}</code></td>
                    <td style={{ fontSize: '0.85rem' }}>
                      {config.fallback?.join(' → ') || 'none'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button 
                        className="btn btn-danger" 
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }} 
                        onClick={() => handleDeleteRoute(alias)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
