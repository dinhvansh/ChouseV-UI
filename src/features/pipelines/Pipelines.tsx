import { useState } from "react";
import { Activity, BookOpen, Boxes, GitBranch, ListTree, Plus, Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useRbacStore, RBAC_PERMISSIONS } from "@/stores";
import { PipelineDesigner } from "./PipelineDesigner";
import { PipelineDeployments, PipelineRuns } from "./PipelineOperations";
import { PipelineMetadata } from "./PipelineMetadata";
import { usePipelines, usePipelineVersions } from "./hooks";

export type PipelineSubTab = "overview" | "designer" | "versions" | "deployments" | "runs" | "metadata";
export const PIPELINE_SUB_TABS: PipelineSubTab[] = ["overview", "designer", "versions", "deployments", "runs", "metadata"];

const TAB_META: Record<PipelineSubTab, { label: string; icon: React.ElementType }> = {
  overview: { label: "Overview", icon: Boxes },
  designer: { label: "Designer", icon: GitBranch },
  versions: { label: "Versions", icon: ListTree },
  deployments: { label: "Deploy", icon: Rocket },
  runs: { label: "Runs", icon: Activity },
  metadata: { label: "Metadata", icon: BookOpen },
};

interface PipelinesProps {
  sub: PipelineSubTab;
  onSubChange: (sub: PipelineSubTab) => void;
}

export function Pipelines({ sub, onSubChange }: PipelinesProps) {
  const { hasPermission } = useRbacStore();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const pipelinesQuery = usePipelines();
  const versionsQuery = usePipelineVersions(selectedId);

  const openDesigner = (id?: string): void => {
    setSelectedId(id);
    onSubChange("designer");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-w-0 items-end justify-between gap-3 border-b border-ink-500 px-6 pt-2">
        <nav className="scrollbar-hide flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Visual Pipeline sections">
          {PIPELINE_SUB_TABS.map((tab) => {
            const Icon = TAB_META[tab].icon;
            return (
              <button key={tab} type="button" onClick={() => onSubChange(tab)} className={cn("relative inline-flex h-9 items-center gap-2 px-3 font-mono text-[11px] uppercase tracking-[0.14em]", sub === tab ? "text-paper" : "text-paper-muted hover:text-paper")}>
                <Icon className={cn("h-3.5 w-3.5", sub === tab && "text-brand")} />{TAB_META[tab].label}
                {sub === tab && <span className="absolute -bottom-px left-0 right-0 h-px bg-brand" />}
              </button>
            );
          })}
        </nav>
        {hasPermission(RBAC_PERMISSIONS.PIPELINES_EDIT) && <Button className="mb-2 rounded-xs" onClick={() => openDesigner()}><Plus className="h-4 w-4" /> New pipeline</Button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {sub === "overview" && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pipelinesQuery.isLoading && [0, 1, 2].map((value) => <Skeleton key={value} className="h-32 rounded-xs" />)}
            {pipelinesQuery.data?.map((pipeline) => (
              <Card key={pipeline.id} className="cursor-pointer rounded-xs border-ink-500 bg-ink-100 p-4 hover:border-brand/50" onClick={() => openDesigner(pipeline.id)}>
                <div className="flex items-start justify-between gap-3"><div><h3 className="font-medium text-paper">{pipeline.name}</h3><p className="mt-1 line-clamp-2 text-xs text-paper-muted">{pipeline.description || "No description"}</p></div><GitBranch className="h-4 w-4 text-brand" /></div>
                <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">Updated {new Date(pipeline.updatedAt).toLocaleString()}</p>
              </Card>
            ))}
            {!pipelinesQuery.isLoading && pipelinesQuery.data?.length === 0 && <Card className="col-span-full rounded-xs border-dashed border-ink-500 bg-ink-100 p-10 text-center text-sm text-paper-muted">No visual pipelines yet.</Card>}
          </div>
        )}
        {sub === "designer" && <PipelineDesigner pipelineId={selectedId} onPipelineChange={setSelectedId} />}
        {sub === "versions" && (
          <div className="space-y-3">
            {!selectedId && <Card className="rounded-xs border-dashed border-ink-500 bg-ink-100 p-10 text-center text-sm text-paper-muted">Open a pipeline from Overview to inspect its versions.</Card>}
            {versionsQuery.data?.map((version) => <Card key={version.id} className="rounded-xs border-ink-500 bg-ink-100 p-4"><div className="flex items-center justify-between"><div><h3 className="font-medium text-paper">Version {version.versionNumber}</h3><p className="mt-1 font-mono text-[10px] text-paper-faint">{version.definitionHash.slice(0, 16)} · compiler {version.compilerVersion ?? "not validated"}</p></div><span className="rounded-full border border-ink-500 px-2 py-1 font-mono text-[10px] text-paper-muted">{version.status}</span></div></Card>)}
          </div>
        )}
        {sub === "deployments" && <PipelineDeployments pipelineId={selectedId} />}
        {sub === "runs" && <PipelineRuns pipelineId={selectedId} />}
        {sub === "metadata" && <PipelineMetadata pipelineId={selectedId} />}
      </div>
    </div>
  );
}
