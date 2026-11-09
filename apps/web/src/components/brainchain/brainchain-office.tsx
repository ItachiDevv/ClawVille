'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { BrainchainCapability, BrainchainCurriculumSection } from '@clawville/shared';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api, ApiError } from '@/lib/api';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { observationTime, officialEvidenceUrl, paymentNetworkLabel, readOffice, type OfficeKnowledge, type OfficeStatus } from './office-api';
import styles from './brainchain-office.module.css';
import { OfficePurchases } from './office-purchases';
import { OfficeAccount } from './office-account';

const SECTIONS = [
  { id: 'learn', label: 'Learn' },
  { id: 'setup', label: 'Worker setup' },
  { id: 'work', label: 'Work status' },
  { id: 'hire', label: 'Hire help' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'recovery', label: 'Recovery' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];
const STATE_LABELS = {
  available: 'Available', 'source-present': 'Code exists', 'not-verified': 'Not verified',
  unavailable: 'Unavailable', planned: 'Not connected',
} as const;

function Curriculum({ sections }: { sections: readonly BrainchainCurriculumSection[] }) {
  return <div className={styles.curriculum}>{sections.map((section) => (
    <article className={styles.lesson} key={section.id}>
      <h3>{section.title}</h3>
      {section.paragraphs.map((paragraph, index) => paragraph.startsWith('```')
        ? <pre key={index} tabIndex={0} aria-label={`${section.title} command example`}><code>{paragraph.replace(/^```\w*\n/, '').replace(/\n```$/, '')}</code></pre>
        : <p key={index}>{paragraph}</p>)}
    </article>
  ))}</div>;
}

function Capability({ capability }: { capability: BrainchainCapability | undefined }) {
  if (!capability) return null;
  const evidenceUrl = officialEvidenceUrl(capability.evidenceUrl);
  return <article className={styles.capability}>
    <span className={styles.state} data-state={capability.status}>{STATE_LABELS[capability.status]}</span>
    <h3>{capability.title}</h3>
    <p>{capability.summary}</p>
    {evidenceUrl && <a href={evidenceUrl} target="_blank" rel="noopener noreferrer">Read the evidence <span aria-hidden="true">↗</span></a>}
  </article>;
}

function Teacher() {
  const auth = useAuthMe();
  const userId = auth.data?.user && !auth.data.user.isGuest ? auth.data.user.id : null;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    request.current?.abort();
    setAnswer(''); setError(''); setQuestion(''); setPending(false);
    return () => { request.current?.abort(); };
  }, [userId]);

  async function askTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = question.trim();
    if (!userId || pending || !content) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError(''); setAnswer('');
    try {
      const response = await api.sendSystemChat('brainchain-office', content, controller.signal);
      if (!controller.signal.aborted) setAnswer(response.message.content);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
        ? 'Your session cannot use the Guide. Sign in with your own account and try again.'
        : 'The Guide cannot answer now. Your question was not retried. Try again shortly.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <aside className={styles.teacher} aria-labelledby="office-guide-heading">
    <div className={styles.eyebrow}>Your teacher</div>
    <h2 id="office-guide-heading">Ask the Office Guide</h2>
    <p>Understand a task, review the setup steps, or ask what your agent needs next.</p>
    {auth.isLoading ? <p role="status">Check your session...</p>
      : auth.isError ? <p role="alert">The Office cannot confirm your session. <button className={styles.textButton} type="button" onClick={() => void auth.refetch()}>Check again</button></p>
        : !userId ? <p>Public lessons stay open to everyone. <Link href="/login">Sign in</Link> to speak with the Guide through your own avatar.</p>
          : <form onSubmit={askTeacher}>
            <label htmlFor="office-question">Your question</label>
            <textarea id="office-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4000} rows={4} required placeholder="What should my agent learn before its first task?" disabled={pending} />
            <p className={styles.small}>Keep private keys, private code, and personal information out of your question.</p>
            <button className={styles.primaryButton} type="submit" disabled={pending || !question.trim()}>{pending ? 'The Guide prepares an answer...' : 'Ask the Guide'}</button>
          </form>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {pending && <p role="status" className={styles.small}>The Guide reads your question.</p>}
    {answer && <div className={styles.answer} role="status"><strong>Office Guide</strong><p>{answer}</p></div>}
  </aside>;
}

export function BrainchainOffice() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [section, setSection] = useState<SectionId>('learn');
  const tabs = useRef<HTMLDivElement>(null);
  const knowledge = useQuery({
    queryKey: ['brainchain-office', 'knowledge'],
    queryFn: ({ signal }) => readOffice<OfficeKnowledge>('knowledge', signal),
    staleTime: 300_000, retry: false,
  });
  const status = useQuery({
    queryKey: ['brainchain-office', 'status'],
    queryFn: ({ signal }) => readOffice<OfficeStatus>('status', signal),
    staleTime: 60_000, retry: false,
  });
  const curriculum = knowledge.data?.sections ?? [];
  const capabilities = knowledge.data?.capabilities ?? [];
  const capability = (id: BrainchainCapability['id']) => capabilities.find((item) => item.id === id);
  const observation = status.data?.observation;

  function returnToTown(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    // No position write: the same world scene retains the actual avatar body.
    const requested = requestWorldStageNavigation({
      to: '/game',
      onExpired: () => { if (window.location.pathname === '/brainchain') router.push('/game'); },
    });
    if (!requested) router.push('/game');
  }

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const index = SECTIONS.findIndex((item) => item.id === section);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length;
    else if (event.key === 'ArrowLeft') next = (index + SECTIONS.length - 1) % SECTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SECTIONS.length - 1;
    else return;
    event.preventDefault();
    const selected = SECTIONS[next]!;
    setSection(selected.id);
    tabs.current?.querySelector<HTMLButtonElement>(`#office-tab-${selected.id}`)?.focus();
  }

  return <div className={styles.page} data-touch={isMobile}>
    <a className={styles.skipLink} href="#office-content">Skip to Office content</a>
    <header className={styles.header}>
      <Link href="/" className={styles.home}>ClawVille <span>/ Partner offices</span></Link>
      <Link href="/game" onClick={returnToTown} className={styles.townLink}>Back to town <span aria-hidden="true">↗</span></Link>
    </header>
    <main className={styles.main}>
      <section className={styles.hero} aria-labelledby="office-title">
        <div>
          <span className={styles.eyebrow}>Learn here. Work beyond town.</span>
          <h1 id="office-title">BrainChain<br /><span>Office</span></h1>
          <p className={styles.intro}>A place to turn your agent&apos;s skills into useful work. Learn the process, prepare a test worker, and review the evidence.</p>
          <div className={styles.heroLinks}><a href="#office-content" className={styles.primaryButton}>Explore the Office <span aria-hidden="true">↓</span></a><a href="https://usebrainchain.com" target="_blank" rel="noopener noreferrer" className={styles.secondaryLink}>Meet BrainChain ↗</a></div>
        </div>
        <div className={styles.workflow} aria-label="The BrainChain work process">
          <div className={styles.workflowHeader}>THE WORK DESK <span>01 / ORIENTATION</span></div>
          {[['01', 'Learn the work', 'Tasks, quality levels, and the worker record.'], ['02', 'Practice on testnet', 'A separate test worker with clear limits.'], ['03', 'Verify each result', 'Receipts and costs before income claims.']].map(([number, title, detail]) => <div key={number} className={styles.workflowStep}><span>{number}</span><div><h2>{title}</h2><p>{detail}</p></div></div>)}
          <p className={styles.workflowFooter}>The Office teaches the steps. It does not start a worker or transfer funds.</p>
        </div>
      </section>

      <section className={styles.officeBody}>
        <div ref={tabs} className={styles.tabs} role="tablist" aria-label="Office areas" onKeyDown={navigateTabs}>
          {SECTIONS.map((item) => <button type="button" key={item.id} id={`office-tab-${item.id}`} role="tab" aria-selected={section === item.id} aria-controls="office-content" tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)}>{item.label}</button>)}
        </div>
        <div className={styles.contentGrid}>
          <section id="office-content" className={styles.content} role="tabpanel" aria-labelledby={`office-tab-${section}`} tabIndex={0}>
            {knowledge.isLoading ? <p role="status">Load the reviewed Office curriculum...</p> : knowledge.isError ? <div role="alert"><h2>The curriculum is unavailable</h2><p>{knowledge.error.message}</p><button className={styles.primaryButton} type="button" onClick={() => void knowledge.refetch()}>Load the curriculum again</button></div> : <>
              <p className={styles.small}>Reviewed {knowledge.data?.reviewedAt} · Curriculum {knowledge.data?.version}</p>
              {section === 'learn' && <><h2>Useful work starts with clear expectations.</h2><p>Learn what BrainChain does, what a worker needs, and which information can become public.</p><Curriculum sections={curriculum.filter((item) => ['purpose', 'worker', 'safety', 'history'].includes(item.id))} /></>}
              {section === 'setup' && <><h2>Prepare a test worker.</h2><p>These steps are for an authorized operator in a separate environment. Test tokens have no cash value.</p><OfficeAccount mode="install" /><Curriculum sections={curriculum.filter((item) => ['networks', 'practice'].includes(item.id))} /><Capability capability={capability('hosted_worker')} /></>}
              {section === 'work' && <><h2>Your agent&apos;s work, with evidence.</h2><OfficeAccount mode="workers" /><div className={styles.notice}><h3>Task history is not available yet.</h3><p>Use the worker status command in your test environment to inspect its current record.</p></div><p>A worker record needs the correct network, worker identity, task reference, delivery, grade, and settlement receipt.</p><Capability capability={capability('hosted_worker')} /><Capability capability={capability('testnet_practice')} /></>}
              {section === 'hire' && <><h2>Give outside work a clear brief.</h2><p>Specify the facts, output format, quality levels, and deadline. Submit only information you can make public.</p><OfficePurchases /><Capability capability={capability('solana_task_purchase')} /><Curriculum sections={curriculum.filter((item) => item.id === 'payments')} /></>}
              {section === 'earnings' && <><h2>Count income after settlement.</h2><div className={styles.notice}><h3>No personal earnings data is connected.</h3><p>An unavailable balance is not a zero balance. The Office cannot report your income or spendable funds yet.</p></div><p>Track accepted income separately from pending income. Deduct model costs, gas, protocol fees, and conversion costs.</p><Capability capability={capability('solana_cash_out')} /><Capability capability={capability('credit')} /></>}
              {section === 'recovery' && <><h2>Keep the evidence. Avoid a second payment.</h2><ol className={styles.recovery}><li>Record the task, network, operation, timestamp, and transaction reference.</li><li>Check the original operation before you submit another request.</li><li>Preserve worker state when you stop or restart the runner.</li><li>Ask the operator to review held funds or an unconfirmed receipt.</li><li>Approve any different payout network separately.</li></ol><p>The private worker panel can request exact-result recovery consent. Only your current linked wallet approves it. The worker stays paused. Unknown uploads permit evidence checks only. Solana payment history searches cannot release refunds or authorize another payment. Old unsigned operations with expired original grants remain unavailable. Never post a private key in a support message.</p><a className={styles.secondaryLink} href="https://docs.usebrainchain.com/run-a-worker" target="_blank" rel="noopener noreferrer">Read the worker recovery guide ↗</a></>}
            </>}
          </section>
          <div className={styles.sideColumn}>
            <Teacher />
            <aside className={styles.observations} aria-labelledby="office-observations-heading">
              <div className={styles.eyebrow}>Observed capabilities</div><h2 id="office-observations-heading">What the service reports</h2>
              <p className={styles.small}>Unpaid checks describe an offer, not a successful payment. They never enable an action here.</p>
              {status.isLoading ? <p role="status">Check service observations...</p> : status.isError ? <p role="alert">Service observations are unavailable.</p> : observation ? <>
                <p className={styles.small}>Observed <time dateTime={observation.observedAt}>{observationTime(observation.observedAt)}</time></p>
                <p><strong>Task payment offers</strong><br />{observation.payment.state === 'observed' ? [...new Set(observation.payment.offers.map((offer) => paymentNetworkLabel(offer.network)))].join(', ') : 'No offer could be verified.'}</p>
                <p><strong>Mainnet exit terms</strong><br />{observation.exits.mainnet.state === 'observed' ? 'Terms returned. A payout is not verified.' : 'No terms could be verified.'}</p>
                <p className={styles.small}>Observation expires {observationTime(observation.expiresAt)}. Curriculum limits remain separate.</p>
              </> : null}
              <button type="button" className={styles.textButton} disabled={status.isFetching} onClick={() => void status.refetch()}>{status.isFetching ? 'Check in progress...' : 'Refresh observations'}</button>
            </aside>
          </div>
        </div>
      </section>
      <footer className={styles.footer}><span>ClawVille × BrainChain</span><p>Skills travel. Evidence stays with the work.</p><Link href="/game" onClick={returnToTown}>Return to ClawVille</Link></footer>
    </main>
  </div>;
}
