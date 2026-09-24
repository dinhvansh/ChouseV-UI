import { useEffect, useMemo, useState } from "react";
import { Activity, History, Play, Rocket, RotateCcw, Square } from "lucide-react";
import { toast } from "sonner";

import type { PipelineConcurrencyPolicy, PipelineTriggerType } from "@/api/pipelines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRbacStore, RBAC_PERMISSIONS } from "@/stores";
import { usePipeline, usePipelineDeployments, usePipelineMutations, usePipelineRuns, usePipelineVersions } from "./hooks";
import { WebhookSetupCard } from "./WebhookSetupCard";

function EmptySelection({ label }: { label: string }) {
  return <Card className="rounded-xs border-dashed border-ink-500 bg-ink-100 p-10 text-center text-sm text-paper-muted">Open a pipeline from Overview to inspect {label}.</Card>;
}

export function PipelineDeployments({ pipelineId }: { pipelineId?: string }) {
  const { hasPermission } = useRbacStore();
  const canDeploy = hasPermission(RBAC_PERMISSIONS.PIPELINES_DEPLOY);
  const canRun = hasPermission(RBAC_PERMISSIONS.PIPELINES_RUN);
  const pipelineQuery = usePipeline(pipelineId);
  const versionsQuery = usePipelineVersions(pipelineId);
  const deploymentsQuery = usePipelineDeployments(pipelineId);
  const mutations = usePipelineMutations();
  const eligibleVersions = useMemo(() => versionsQuery.data?.filter((version) => version.status === "TESTED" || version.status === "DEPLOYED") ?? [], [versionsQuery.data]);
  const [versionId, setVersionId] = useState("");
  const [triggerType, setTriggerType] = useState<PipelineTriggerType>("manual");
  const [concurrencyPolicy, setConcurrencyPolicy] = useState<PipelineConcurrencyPolicy>("do_not_overlap");
  const [cronExpr, setCronExpr] = useState("0 * * * *");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const active = deploymentsQuery.data?.find((deployment) => deployment.status === "ACTIVE");

  useEffect(() => {
    if (!versionId && eligibleVersions[0]) setVersionId(eligibleVersions[0].id);
  }, [eligibleVersions, versionId]);
  useEffect(() => {
    if (!active) return;
    setVersionId(active.versionId);
    setTriggerType(active.triggerType);
    const policy = active.triggerConfig?.concurrencyPolicy;
    if (policy === "do_not_overlap" || policy === "queue_one" || policy === "allow_parallel") {
      setConcurrencyPolicy(policy);
    }
    const activeCron = active.triggerConfig?.cronExpr;
    if (typeof activeCron === "string") setCronExpr(activeCron);
    const activeTimezone = active.triggerConfig?.timezone;
    if (typeof activeTimezone === "string") setTimezone(activeTimezone);
  }, [active]);
  useEffect(() => {
    setWebhookSecret(null);
  }, [pipelineId]);
  if (!pipelineId) return <EmptySelection label="deployments" />;
  const activeWebhook = active?.triggerType === "webhook" && active.hasWebhookSecret;

  const deploy = async (): Promise<void> => {
    if (!versionId) return;
    try {
      const result = await mutations.deploy.mutateAsync({
        id: pipelineId,
        input: {
          versionId,
          triggerType,
          concurrencyPolicy,
          ...(triggerType === "schedule" || triggerType === "refreshable_mv" ? { frequency: "cron", cronExpr, timezone } : {}),
        },
      });
      setWebhookSecret(result.webhookSecret);
      result.warnings.forEach((warning) => toast.warning(warning));
      toast.success("Pipeline deployed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Deployment failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="rounded-xs border-ink-500 bg-ink-100 p-4">
        <div className="mb-4 flex items-center gap-2"><Rocket className="h-4 w-4 text-brand" /><h3 className="font-medium text-paper">Deploy {pipelineQuery.data?.name}</h3></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Tested version"><Select value={versionId} onValueChange={setVersionId}><SelectTrigger><SelectValue placeholder="Select version" /></SelectTrigger><SelectContent>{eligibleVersions.map((version) => <SelectItem key={version.id} value={version.id}>v{version.versionNumber} · {version.status}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Trigger"><Select value={triggerType} onValueChange={(value) => setTriggerType(value as PipelineTriggerType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="manual">Manual</SelectItem><SelectItem value="schedule">Schedule</SelectItem><SelectItem value="webhook">Webhook</SelectItem><SelectItem value="incremental_mv">Incremental MV</SelectItem><SelectItem value="refreshable_mv">Refreshable MV</SelectItem></SelectContent></Select></Field>
          <Field label="Concurrency"><Select value={concurrencyPolicy} onValueChange={(value) => setConcurrencyPolicy(value as PipelineConcurrencyPolicy)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="do_not_overlap">Do not overlap</SelectItem><SelectItem value="queue_one">Queue one</SelectItem><SelectItem value="allow_parallel">Allow parallel</SelectItem></SelectContent></Select></Field>
          {(triggerType === "schedule" || triggerType === "refreshable_mv") && <Field label="Timezone"><Input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>}
        </div>
        {(triggerType === "schedule" || triggerType === "refreshable_mv") && <div className="mt-3 max-w-sm"><Field label="Cron expression"><Input value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} /></Field></div>}
        <div className="mt-4 flex flex-wrap gap-2">
          {canDeploy && <Button onClick={() => void deploy()} disabled={!versionId || mutations.deploy.isPending}><Rocket className="h-4 w-4" /> {active ? "Redeploy" : "Deploy"}</Button>}
          {canRun && active?.runtimeJobId && <Button variant="outline" onClick={() => void mutations.run.mutateAsync(pipelineId).then((result) => toast.success(result.queued ? "Run queued" : "Run completed")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Run failed"))}><Play className="h-4 w-4" /> Run manually</Button>}
          {canDeploy && active && <Button variant="outline" onClick={() => void mutations.retire.mutateAsync(pipelineId).then(() => toast.success("Deployment retired")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Retire failed"))}><Square className="h-4 w-4" /> Retire</Button>}
        </div>
      </Card>
      {(webhookSecret || activeWebhook) && <WebhookSetupCard pipelineId={pipelineId} secret={webhookSecret} />}
      <div className="space-y-2">
          {deploymentsQuery.data?.map((deployment) => (
          <Card key={deployment.id} className="rounded-xs border-ink-500 bg-ink-100 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium text-paper">{deployment.triggerType} · {deployment.status}</p><p className="mt-1 font-mono text-[10px] text-paper-faint">{deployment.artifactChecksum.slice(0, 16)} · {new Date(deployment.deployedAt).toLocaleString()}</p><p className="mt-1 text-xs text-paper-muted">Runtime: {deployment.nativeObjectName ?? deployment.runtimeJobId ?? "none"}</p></div>{canDeploy && deployment.status !== "ACTIVE" && <Button size="sm" variant="outline" onClick={() => void mutations.rollback.mutateAsync({ id: pipelineId, deploymentId: deployment.id }).then((result) => { setWebhookSecret(result.webhookSecret); result.warnings.forEach((warning) => toast.warning(warning)); toast.success("Rollback deployed from frozen artifact"); }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Rollback failed"))}><RotateCcw className="h-4 w-4" /> Roll back</Button>}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function PipelineRuns({ pipelineId }: { pipelineId?: string }) {
  const runsQuery = usePipelineRuns(pipelineId);
  if (!pipelineId) return <EmptySelection label="execution history" />;
  const runs = runsQuery.data?.runs ?? [];
  const nativeRuns = runsQuery.data?.nativeRuns ?? [];
  return <div className="space-y-4"><div className="flex items-center gap-2 text-paper"><Activity className="h-4 w-4 text-brand" /><h3 className="font-medium">Execution history</h3></div>{runs.map((run) => <RunCard key={run.id} title={`${run.triggerType} · ${run.status}`} startedAt={run.startedAt} durationMs={run.durationMs} rows={run.writtenRows ?? run.rowCount} error={run.errorMessage} sql={run.generatedSql} payload={run.triggerPayload} />)}{nativeRuns.map((run) => <RunCard key={run.id} title={`incremental_mv · ${run.status}`} startedAt={run.eventTimeMs} durationMs={run.durationMs} rows={run.writtenRows} error={run.errorMessage} sql={null} payload={{ initialQueryId: run.initialQueryId, viewUuid: run.viewUuid }} />)}{!runsQuery.isLoading && runs.length + nativeRuns.length === 0 && <Card className="rounded-xs border-dashed border-ink-500 bg-ink-100 p-10 text-center text-sm text-paper-muted">No executions recorded yet.</Card>}</div>;
}

function RunCard({ title, startedAt, durationMs, rows, error, sql, payload }: { title: string; startedAt: number; durationMs: number | null; rows: number | null; error: string | null; sql: string | null; payload: unknown }) {
  return <Card className="rounded-xs border-ink-500 bg-ink-100 p-4"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><History className="h-4 w-4 text-paper-faint" /><p className="text-sm font-medium text-paper">{title}</p></div><p className="mt-1 font-mono text-[10px] text-paper-faint">{new Date(startedAt).toLocaleString()} · {durationMs ?? "—"} ms · {rows ?? "—"} rows</p></div></div>{error && <pre className="mt-3 overflow-auto rounded-xs border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</pre>}<details className="mt-3 text-xs text-paper-muted"><summary className="cursor-pointer">Execution detail</summary>{sql && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xs bg-ink-50 p-3 font-mono">{sql}</pre>}<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xs bg-ink-50 p-3 font-mono">{JSON.stringify(payload, null, 2)}</pre></details></Card>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint">{label}</Label>{children}</div>;
}
