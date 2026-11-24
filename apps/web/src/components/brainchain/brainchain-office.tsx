'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { BRAINCHAIN_WORKER_TERMS, type BrainchainCapability, type BrainchainCurriculumSection } from '@clawville/shared';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api, ApiError } from '@/lib/api';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { observationTime, officialEvidenceUrl, paymentNetworkLabel, readOffice, type OfficeKnowledge, type OfficeStatus } from './office-api';
import styles from './brainchain-office.module.css';
import { placeAtBrainchainOfficeExit } from '@/lib/three/brainchain-office-transition';
import { OfficeBoardRecords } from './office-board-records';
import { OfficeAccount } from './office-account';
import { useOfficeBoardData } from './office-board-data';

const SECTIONS = [
  { id: 'learn', label: 'What is this?', sub: '2 minute intro' },
  { id: 'setup', label: 'Connect your AI', sub: 'Make it a worker' },
  { id: 'work', label: 'Jobs', sub: 'What your AI is doing' },
  { id: 'earnings', label: 'Earnings', sub: 'What it got paid' },
] as const;
export type SectionId = (typeof SECTIONS)[number]['id'] | 'recovery';
const STATE_LABELS = {
  available: 'Available', 'source-present': 'Code exists', 'not-verified': 'Not verified',
  unavailable: 'Unavailable', planned: 'Not connected',
} as const;
const GUIDE = {
  learn: { intro: 'Hi. I run this Office. Ask me anything, there are no silly questions here. Most people start with one of these:', questions: ['What is an AI worker?', 'What does it cost to start?', 'Can I lose money?', 'Can my ClawVille agent do this?'] },
  setup: { intro: 'This step needs some setup on a computer. I can walk you through it one step at a time. Want to check first if it is worth it for you?', questions: ['How long does setup take?', 'What is BRAIN and where do I get it?', 'How much can a worker earn?'] },
  work: { intro: 'Your worker program does the jobs on its own. Ask me what a status means.', questions: ['What does "being checked" mean?', 'How do I pause my AI?', 'Why was a job not paid?'] },
  earnings: { intro: 'Pay counts after the review ends. Ask me how to read your worker records and check the costs.', questions: ['When is a job paid?', 'What fees do I pay?', 'How do I take my money out?'] },
  recovery: { intro: 'Keep the job and payment records. Check the first request before you try again. I can explain the next step.', questions: ['My job was not paid. What now?', 'How do I pause my AI?', 'Is my money safe?'] },
};

function Curriculum({ sections }: { sections: readonly BrainchainCurriculumSection[] }) {
  return <div className={styles.curriculum}>{sections.map(section => <article className={styles.lesson} key={section.id}>
    <h3>{section.title}</h3>{section.paragraphs.map((paragraph, index) => paragraph.startsWith('```')
      ? <pre key={index} tabIndex={0} aria-label={`${section.title} command example`}><code>{paragraph.replace(/^```\w*\n/, '').replace(/\n```$/, '')}</code></pre>
      : <p key={index}>{paragraph}</p>)}
  </article>)}</div>;
}

function Capability({ capability }: { capability: BrainchainCapability | undefined }) {
  if (!capability) return null;
  const evidenceUrl = officialEvidenceUrl(capability.evidenceUrl);
  return <article className={styles.capability}><span className={styles.state} data-state={capability.status}>{STATE_LABELS[capability.status]}</span><h3>{capability.title}</h3><p>{capability.summary}</p>{evidenceUrl && <a href={evidenceUrl} target="_blank" rel="noopener noreferrer">Read the evidence ↗</a>}</article>;
}

function Teacher({ section, hasWorker, focusRequest }: { section: SectionId; hasWorker: boolean; focusRequest: number }) {
  const auth = useAuthMe();
  const userId = !auth.isError && auth.data?.user && !auth.data.user.isGuest ? auth.data.user.id : null;
  const [question, setQuestion] = useState('');
  const [sent, setSent] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { if (focusRequest > 0) setExpanded(true); }, [focusRequest]);
  useEffect(() => {
    if (!expanded || focusRequest <= 0) return;
    const input = document.querySelector<HTMLTextAreaElement>('#office-question:not(:disabled)');
    const target = input?.getClientRects().length ? input : document.getElementById('office-teacher');
    target?.focus(); target?.scrollIntoView({ block: 'center' });
  }, [expanded, focusRequest, userId]);
  useEffect(() => {
    request.current?.abort();
    setAnswer(''); setError(''); setQuestion(''); setSent(''); setPending(false);
    return () => { request.current?.abort(); };
  }, [userId]);
  async function askTeacher(content: string) {
    content = content.trim();
    if (!userId || pending || !content) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError(''); setAnswer(''); setSent(content); setQuestion('');
    try {
      const response = await api.sendSystemChat('brainchain-office', content, controller.signal);
      if (!controller.signal.aborted) setAnswer(response.message.content);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
        ? 'Your session cannot use Cortex. Sign in with your own account and try again.'
        : 'Cortex cannot answer now. Your question was not retried. Try again shortly.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  const guide = GUIDE[section];
  return <aside id="office-teacher" tabIndex={-1} className={styles.teacher} aria-labelledby="office-guide-heading" onFocus={event => { if (event.target === event.currentTarget) setExpanded(true); }}>
    <button type="button" className={styles.teacherToggle} aria-expanded={expanded} aria-controls="office-teacher-body" onClick={() => setExpanded(!expanded)}>Ask Cortex <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
    <div id="office-teacher-body" className={styles.teacherBody} data-expanded={expanded}>
      <div className={styles.who}><span className={styles.orb} aria-hidden="true" /><div><h2 id="office-guide-heading">Cortex</h2><span>YOUR GUIDE · ONLINE</span></div></div>
      <p className={styles.bubble}>{section === 'work' && !hasWorker ? 'Connect your AI to see its jobs here. Ask me how to start.' : guide.intro}</p>
      <div className={styles.chips}>{guide.questions.map(chip => <button type="button" key={chip} disabled={!userId || pending} onClick={() => void askTeacher(chip)}>{chip}</button>)}</div>
      {sent && <div className={styles.userBubble}><strong>You</strong><p>{sent}</p></div>}
      {answer && <div className={styles.bubble} role="status"><strong>Cortex</strong><p>{answer}</p></div>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {pending && <p role="status" className={styles.small}>Cortex reads your question.</p>}
      {auth.isLoading ? <p role="status">Check your session...</p> : auth.isError ? <p role="alert">The Office cannot confirm your session. <button className={styles.textButton} type="button" onClick={() => void auth.refetch()}>Check again</button></p> : !userId ? <Link href="/login">Sign in to ask Cortex</Link> : null}
      <form className={styles.ask} onSubmit={event => { event.preventDefault(); void askTeacher(question); }}>
        <textarea id="office-question" aria-label="Your question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={4000} rows={1} required placeholder="Type a question..." disabled={!userId || pending} />
        <button type="submit" className={styles.primaryButton} disabled={!userId || pending || !question.trim()}>Ask</button>
      </form><p className={styles.small}>Never paste a private key or password here.</p>
    </div>
  </aside>;
}

function Heading({ first, second }: { first: string; second: string }) {
  return <h1 className={styles.headline}>{first}<span>{second}</span></h1>;
}

export function BrainchainOffice({ initialSection = 'learn', windowed = false, onClose, teacherFocus = 0 }: { initialSection?: SectionId; windowed?: boolean; onClose?: () => void; teacherFocus?: number } = {}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const auth = useAuthMe();
  const userId = !auth.isError && auth.data?.user && !auth.data.user.isGuest ? auth.data.user.id : null;
  const { summary, counts, workers } = useOfficeBoardData();
  const workerView = userId && summary.ownerId === userId && summary.task.view.kind === 'tasks' ? summary.task.view : null;
  const hasWorker = !!userId && !auth.isLoading && summary.ownerId === userId && workers.length > 0;
  const [section, setSection] = useState<SectionId>(initialSection);
  const [seenIntro, setSeenIntro] = useState<string | null>(null);
  const seenViewers = useRef(new Set<string>());
  const viewer = userId ?? 'visitor';
  const tabs = useRef<HTMLDivElement>(null);
  const setupSteps = useRef<HTMLDetailsElement>(null);
  useEffect(() => { setSection(initialSection); }, [initialSection]);
  useEffect(() => {
    let seen = seenViewers.current.has(viewer);
    try { seen = seen || localStorage.getItem(`brainchain-office:intro:${viewer}`) === '1'; } catch { /* Storage is optional. */ }
    if (section === 'learn') {
      seen = true;
      try { localStorage.setItem(`brainchain-office:intro:${viewer}`, '1'); } catch { /* Storage is optional. */ }
    }
    if (seen) seenViewers.current.add(viewer);
    setSeenIntro(seen ? viewer : null);
  }, [viewer, section]);
  const knowledge = useQuery({ queryKey: ['brainchain-office', 'knowledge'], queryFn: ({ signal }) => readOffice<OfficeKnowledge>('knowledge', signal), staleTime: 300_000, retry: false });
  const status = useQuery({ queryKey: ['brainchain-office', 'status'], queryFn: ({ signal }) => readOffice<OfficeStatus>('status', signal), staleTime: 60_000, retry: false });
  const curriculum = knowledge.data?.sections ?? [];
  const capability = (id: BrainchainCapability['id']) => knowledge.data?.capabilities.find(item => item.id === id);
  const observation = status.data?.observation;
  const terms = BRAINCHAIN_WORKER_TERMS;
  function focusTeacher() {
    const input = document.querySelector<HTMLTextAreaElement>('#office-question:not(:disabled)');
    const target = input?.getClientRects().length ? input : document.getElementById('office-teacher');
    target?.focus(); target?.scrollIntoView({ block: 'center' });
  }
  function returnToTown(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    const requested = requestWorldStageNavigation({ to: '/game', onMidway: placeAtBrainchainOfficeExit,
      onExpired: () => { if (window.location.pathname === '/brainchain') { placeAtBrainchainOfficeExit(); router.push('/game'); } },
    });
    if (!requested) { placeAtBrainchainOfficeExit(); router.push('/game'); }
  }
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const index = SECTIONS.findIndex(item => item.id === section);
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % SECTIONS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + SECTIONS.length - 1) % SECTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    const selected = SECTIONS[next]!;
    setSection(selected.id);
    tabs.current?.querySelector<HTMLButtonElement>(`#office-tab-${selected.id}`)?.focus();
  }
  return <div className={styles.page} data-touch={isMobile} data-windowed={windowed}>
    <a className={styles.skipLink} href="#office-content">Skip to Office content</a>
    <header className={styles.header}>
      <div className={styles.brand}><img src="/brand/brainchain-mark-dot.svg" width={24} height={24} alt="" /><span>BRAINCHAIN OFFICE</span></div>
      <span className={styles.live}><i aria-hidden="true" />MAINNET LIVE</span>
      <span className={styles.ticker}>{section === 'work' && workerView ? `YOUR AI · ${workerView.worker.state.toUpperCase()} · ${workerView.worker.address}` : status.isLoading ? 'CHECKING SERVICE' : status.isError || !observation ? 'SERVICE CHECK UNAVAILABLE' : `BRAINCHAIN SERVICE · CHECKED ${observationTime(observation.observedAt)}`}</span>
      {windowed ? <><span className={styles.escape}>ESC</span><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close Office">×</button></> : <Link href="/game" onClick={returnToTown} className={styles.townLink}>Back to town ↗</Link>}
    </header>
    <div className={styles.officeBody}>
      <nav className={styles.rail} aria-label="Office path"><h2>YOUR PATH</h2>
        <div ref={tabs} className={styles.tabs} role="tablist" aria-label="Office areas" onKeyDown={navigateTabs}>
          {SECTIONS.map((item, index) => {
            const done = item.id === 'learn' ? seenIntro === viewer : item.id === 'setup' && hasWorker;
            return <button type="button" key={item.id} id={`office-tab-${item.id}`} role="tab" aria-selected={section === item.id} aria-controls="office-content" tabIndex={section === item.id || section === 'recovery' && index === 0 ? 0 : -1} data-done={done} onClick={() => setSection(item.id)}>
              <span className={styles.stepNumber}>{done && section !== item.id ? '✓' : `0${index + 1}`}</span><span><strong>{item.label}</strong><small>{item.id === 'work' && counts ? `${counts.totalLabel} jobs` : done && section !== item.id ? item.id === 'learn' ? 'Done' : 'Worker linked' : item.sub}</small></span>
            </button>;
          })}
        </div>
        <div className={styles.help}><p>Need help?</p><button id="office-tab-recovery" type="button" className={styles.textButton} aria-current={section === 'recovery' ? 'page' : undefined} onClick={() => setSection('recovery')}>Fix a problem ↗</button><a href="https://docs.usebrainchain.com" target="_blank" rel="noopener noreferrer">BrainChain docs ↗</a></div>
      </nav>
      <section id="office-content" className={styles.content} role="tabpanel" aria-labelledby={`office-tab-${section}`} tabIndex={0}>
        {section === 'learn' && <svg className={styles.orbit} viewBox="0 0 900 900" fill="none" aria-hidden="true"><g stroke="currentColor"><ellipse cx="450" cy="450" rx="420" ry="250" transform="rotate(-12 450 450)" /><ellipse cx="450" cy="450" rx="330" ry="360" transform="rotate(25 450 450)" /><ellipse cx="450" cy="450" rx="260" ry="190" transform="rotate(60 450 450)" /><ellipse cx="450" cy="450" rx="380" ry="300" transform="rotate(-40 450 450)" /></g><g stroke="#f386a1"><ellipse cx="450" cy="450" rx="300" ry="220" transform="rotate(40 450 450)" /><ellipse cx="450" cy="450" rx="190" ry="140" transform="rotate(-20 450 450)" /><circle cx="450" cy="450" r="70" strokeDasharray="2 4" strokeWidth="3" /><path d="M310 560 Q400 560 470 440" strokeWidth="20" strokeLinecap="round" /></g></svg>}
        <div className={styles.contentInner}>
          <div className={styles.eyebrow}>{section === 'recovery' ? 'NEED HELP' : `STEP 0${SECTIONS.findIndex(item => item.id === section) + 1} · ${SECTIONS.find(item => item.id === section)?.label.toUpperCase()}`}</div>
          {knowledge.isLoading && <p role="status">Load the reviewed Office curriculum...</p>}
          {knowledge.isError && <div role="alert"><p>The curriculum is unavailable.</p><button className={styles.textButton} type="button" onClick={() => void knowledge.refetch()}>Load the curriculum again</button></div>}
          {section === 'learn' && <>
            <Heading first="Your AI does work." second="You get paid." />
            <p className={styles.lead}>BrainChain is a job market for AI. People post small jobs. <b>AI workers</b> do them. A checker grades each result, and <b>good work gets paid</b> in USDG, a dollar coin.</p>
            <div className={styles.flow}>{[['POSTED', 'Someone posts a job', 'For example: summarize a page, fix a bug.'], ['HIRED', 'Your AI takes it', 'It does the work and sends the result.'], ['PAID', 'The result is checked', 'Good work pays. Bad work pays nothing.']].map(([name, title, detail], index) => <div key={name}><span>0{index + 1} · {name}</span><h3>{title}</h3><p>{detail}</p></div>)}</div>
            <div className={styles.actionRow}><button type="button" className={styles.primaryButton} onClick={() => setSection('setup')}>Next: connect your AI →</button><button type="button" className={styles.outlineButton} onClick={focusTeacher}>Ask Cortex first</button></div>
            <details className={styles.disclosure}><summary>Read the full lessons</summary><Curriculum sections={curriculum.filter(item => ['purpose', 'worker', 'safety', 'history'].includes(item.id))} /></details>
          </>}
          {section === 'setup' && <>
            <Heading first="Make your AI" second="a worker." />
            <div className={styles.cardGrid}>
              <article className={`${styles.card} ${styles.available}`}><span className={styles.cardLabel}>AVAILABLE NOW</span><h3>I run my own AI worker</h3><p>You run BrainChain&apos;s worker program on your computer. Then you link it here with one signed message.</p><div className={styles.actionRow}><button type="button" className={styles.primaryButton} onClick={() => { if (setupSteps.current) { setupSteps.current.open = true; setupSteps.current.scrollIntoView({ block: 'start' }); setupSteps.current.querySelector('summary')?.focus(); } }}>Show me the steps →</button><button type="button" className={styles.outlineButton} onClick={() => { const form = document.getElementById('office-worker-connect') as HTMLDetailsElement | null; if (form) form.open = true; const target = document.getElementById('office-worker-address') ?? document.getElementById('office-link-worker'); target?.scrollIntoView({ block: 'center' }); target?.focus(); }}>I have one</button></div></article>
              <article className={styles.card}><span className={styles.cardLabel}>IDEA · NOT BUILT</span><h3>ClawVille runs it for me</h3><p>For hosted agents. The idea is one click, no computer setup. Not built yet: it needs BrainChain to agree.</p></article>
            </div>
            <div className={styles.cardGrid}>
              <article className={styles.card}><h3 className={styles.cardLabel}>WHAT YOU NEED</h3><ol className={styles.needs}><li>A computer that stays on<small>The worker program runs there and takes jobs.</small></li><li>A separate wallet for the worker<small>Never use your main wallet.</small></li><li>BRAIN tokens to stake<small>BrainChain holds them while you work.</small></li></ol></article>
              <article className={`${styles.card} ${styles.warning}`}><h3 className={styles.cardLabel}>WHAT IT COSTS · READ FIRST</h3>{[['Stake (held, not spent)', terms.minimumStake], ['Application bond', terms.applicationBond], ['Fee on each paid job', `${terms.protocolFeePercent}%`], ['Risk if you lose a dispute', `${terms.disputeLossPercent}% of stake`]].map(([name, value]) => <div className={styles.cost} key={name}><span>{name}</span><b>{value}</b></div>)}<p className={styles.small}>The dispute loss applies when you open a dispute and lose. A refused application can burn its bond. BRAIN token prices can change.</p></article>
            </div>
            <details id="office-setup-steps" ref={setupSteps} className={styles.disclosure}><summary>Setup steps</summary><Curriculum sections={curriculum.filter(item => ['networks', 'practice'].includes(item.id))} /><OfficeAccount mode="install" /></details>
            <div id="office-link-worker" tabIndex={-1}><OfficeAccount mode="connect" /></div>
          </>}
          {section === 'work' && <>
            {!userId && !auth.isLoading && !auth.isError ? <div className={styles.card}><h1>Sign in to see your AI&apos;s jobs</h1><Link className={styles.primaryButton} href="/login">Sign in</Link></div>
              : workerView ? <><Heading first="Your AI is" second="on the job." /><div className={styles.stats}>
                <div><span>STATUS</span><b>{workerView.worker.state}</b><small>{workerView.worker.eligibility}</small></div>
                <div><span>IN PROGRESS</span><b>{counts?.inProgressLabel ?? '…'}</b><small>{counts && counts.needsWork > 0 ? `${counts.needsWork} ${counts.needsWork === 1 ? 'needs' : 'need'} work now` : 'Jobs being worked on or checked'}</small></div>
                <div><span>PAID JOBS</span><b>{counts?.paidLabel ?? '…'}</b><small>Details in Earnings</small></div>
              </div><p className={styles.small}>Status shows your saved request. Your operator must confirm the actual worker state. Counts cover fetched jobs for up to two workers.{counts?.limited && ' More jobs may exist.'}</p><OfficeBoardRecords kind="task" /></>
                : summary.task.view.kind === 'steps' ? <><Heading first="No AI connected" second="yet." /><button type="button" className={styles.primaryButton} onClick={() => setSection('setup')}>Connect your AI →</button></> : <OfficeBoardRecords kind="task" />}
            {userId && <details className={styles.disclosure}><summary>Manage your AI</summary><OfficeAccount mode="workers" /><Capability capability={capability('hosted_worker')} /><Capability capability={capability('testnet_practice')} /></details>}
          </>}
          {section === 'earnings' && <><Heading first="What your AI" second="got paid." /><div className={styles.notice}><h3>Your account records</h3><p>Use the worker record button to read paid bounties.</p><p>An unavailable balance is not a zero balance.</p></div><OfficeBoardRecords kind="receipts" /><details className={styles.disclosure}><summary>How payment works</summary><p>Track accepted income separately from pending income. Deduct model costs, gas, protocol fees, and conversion costs.</p><Curriculum sections={curriculum.filter(item => item.id === 'payments')} /><Capability capability={capability('solana_cash_out')} /><Capability capability={capability('credit')} /></details></>}
          {section === 'recovery' && <><Heading first="Fix a" second="problem." /><ol className={styles.recovery}><li>Save the job, network, action, time, and transaction reference.</li><li>Check the first action before you send another request.</li><li>Keep worker state when you stop or restart the program.</li><li>Ask the operator to check held funds or an unconfirmed receipt.</li><li>Approve a different payout network separately.</li></ol><p>The private worker panel can request exact-result recovery consent. Only your current linked wallet approves it. The worker stays paused. Unknown uploads permit evidence checks only. Old unsigned operations with expired original grants remain unavailable. Never post a private key in a support message.</p><a className={styles.secondaryLink} href="https://docs.usebrainchain.com/run-a-worker" target="_blank" rel="noopener noreferrer">Read the worker recovery guide ↗</a>
            <article className={styles.observations}><h2>Service status</h2><p className={styles.small}>Unpaid checks describe an offer, not a successful payment. They never enable an action here.</p>
              {status.isLoading ? <p role="status">Check service observations...</p> : status.isError ? <p role="alert">Service observations are unavailable.</p> : observation ? <><p className={styles.small}>Observed <time dateTime={observation.observedAt}>{observationTime(observation.observedAt)}</time></p><p><strong>Task payment offers</strong><br />{observation.payment.state === 'observed' ? [...new Set(observation.payment.offers.map(offer => paymentNetworkLabel(offer.network)))].join(', ') : 'No offer could be verified.'}</p><p><strong>Mainnet exit terms</strong><br />{observation.exits.mainnet.state === 'observed' ? 'Terms returned. A payout is not verified.' : 'No terms could be verified.'}</p><p className={styles.small}>Observation expires {observationTime(observation.expiresAt)}. Curriculum limits remain separate.</p></> : null}
              <button type="button" className={styles.textButton} disabled={status.isFetching} onClick={() => void status.refetch()}>{status.isFetching ? 'Check in progress...' : 'Refresh observations'}</button>
            </article>
          </>}
        </div>
      </section>
      <Teacher key={userId ?? 'signed-out'} section={section} hasWorker={hasWorker} focusRequest={teacherFocus} />
    </div>
  </div>;
}
