import StageProof from './stage-proof';

interface StageProofPageProps {
  searchParams: Promise<{
    stage?: string | string[];
  }>;
}

export default async function StageProofPage({
  searchParams,
}: StageProofPageProps) {
  const params = await searchParams;
  const stageFlag = Array.isArray(params.stage)
    ? params.stage[0]
    : params.stage;
  const allowed =
    process.env.NODE_ENV === 'development' || stageFlag === '1';

  if (!allowed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-sm text-slate-300">
        The persistent world-stage proof is disabled. Add{' '}
        <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 text-cyan-200">
          ?stage=1
        </code>
        to enable this isolated diagnostic route.
      </main>
    );
  }

  return <StageProof />;
}
