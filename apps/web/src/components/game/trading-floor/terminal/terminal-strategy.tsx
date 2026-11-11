'use client';

import { useState } from 'react';
import { cloneFloorArenaParams, validateFloorArenaParams, type FloorArenaParams } from '@clawville/shared';
import { FloorArenaApiError, floorArenaErrorCopy, usePatchFloorArenaParams } from '@/hooks/use-floor-arena';
import { ArenaParamsForm } from '../arena/arena-params-form';
import { ArenaParamsSummary } from '../arena/arena-parts';
import { ArenaHardRules } from '../arena/arena-kit';

const SECTIONS = [
  ['coins', 'Coins it looks at'], ['buy', 'When it buys'], ['sell', 'When it sells'],
  ['limits', 'Size and limits'], ['review', 'Review'],
] as const;
type Section = typeof SECTIONS[number][0];
const button = { minHeight: 44, border: '1px solid #16408a', borderRadius: 8, padding: '8px 12px', color: '#F8F0D8', background: '#001858', cursor: 'pointer', font: '600 14px Barlow, sans-serif' };

export function TerminalStrategy({ params, compact }: { params: FloorArenaParams; compact: boolean }) {
  const [draft, setDraft] = useState(() => cloneFloorArenaParams(params));
  const [section, setSection] = useState<Section>('coins');
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const save = usePatchFloorArenaParams();
  const submit = () => {
    const result = validateFloorArenaParams(draft);
    if (!result.ok) { setErrors(result.errors); setSection('review'); return; }
    setErrors([]);
    setMessage(null);
    save.mutate({ params: result.params }, {
      onSuccess: () => setMessage('Rules saved. They apply from the next scan.'),
      onError: (error) => {
        if (error instanceof FloorArenaApiError) setErrors(error.errors);
        setMessage(floorArenaErrorCopy(error));
      },
    });
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" style={button} disabled={save.isPending} onClick={() => { setDraft(cloneFloorArenaParams(params)); setErrors([]); setMessage(null); }}>Reset changes</button>
      <button type="button" style={{ ...button, background: '#B8F800', color: '#0b1600' }} disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving...' : 'Save rules'}</button>
    </div>
    {message && <p role="status">{message}</p>}
    <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', gap: 16 }}>
      <nav aria-label="Strategy sections" style={{ flex: '1 1 160px', minWidth: 0, display: 'flex', flexDirection: compact ? 'row' : 'column', flexWrap: 'wrap', gap: 6, alignContent: 'start' }}>
        {SECTIONS.map(([key, label]) => <button key={key} type="button" aria-pressed={section === key} style={{ ...button, textAlign: 'left', background: section === key ? '#F8D038' : '#00103f', color: section === key ? '#1a0f05' : '#c3cce6' }} onClick={() => setSection(key)}>{label}</button>)}
      </nav>
      <div style={{ flex: '4 1 280px', minWidth: 'min(280px, 100%)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {section === 'review' ? <section aria-label="Review"><h3>Review</h3><ArenaHardRules /><p>Compare the current rules with your draft before you save.</p><h4>Current rules</h4><ArenaParamsSummary params={params} />{errors.map((error) => <p role="alert" key={error} style={{ color: '#FF8A75' }}>{error}</p>)}</section> : <ArenaParamsForm value={draft} onChange={setDraft} errors={errors} compact={compact} disabled={save.isPending} section={section} />}
        <p style={{ fontSize: 12, color: '#a7b4d8' }}>Changes apply to new positions. Open positions keep their original exit rules.</p>
      </div>
        <aside aria-label="Rules at a glance" style={{ flex: '1 1 220px', minWidth: 0, border: '1px solid #16408a', padding: 16, background: '#00103f', borderRadius: 12 }}>
          <h3 style={{ marginTop: 0, color: '#E0C070', fontSize: 14 }}>Rules at a glance</h3>
          <ArenaParamsSummary params={draft} />
        </aside>
    </div>
  </div>;
}
