import { useEffect, useState } from "react";
import { BookOpen, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { PipelineBusinessMetadata } from "@/api/pipelines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRbacStore, RBAC_PERMISSIONS } from "@/stores";
import { usePipeline, usePipelineMetadata, usePipelineMutations } from "./hooks";

type MetadataDraft = Omit<PipelineBusinessMetadata, "id" | "pipelineId" | "createdAt" | "updatedAt">;

const EMPTY: MetadataDraft = { entityType: "pipeline", entityKey: "pipeline", description: "", businessOwner: "", dataOwner: "", sensitivity: "", sourceSystem: "", refreshFrequency: "", businessDefinition: "" };

export function PipelineMetadata({ pipelineId }: { pipelineId?: string }) {
  const pipelineQuery = usePipeline(pipelineId);
  const metadataQuery = usePipelineMetadata(pipelineId);
  const mutations = usePipelineMutations();
  const canEdit = useRbacStore((state) => state.hasPermission(RBAC_PERMISSIONS.PIPELINES_METADATA));
  const [draft, setDraft] = useState<MetadataDraft>(EMPTY);
  useEffect(() => {
    const pipelineMetadata = metadataQuery.data?.find((item) => item.entityType === "pipeline" && item.entityKey === "pipeline");
    if (pipelineMetadata) {
      const { id: _id, pipelineId: _pipelineId, createdAt: _createdAt, updatedAt: _updatedAt, ...editable } = pipelineMetadata;
      setDraft(editable);
    }
  }, [metadataQuery.data]);
  if (!pipelineId) return <Card className="rounded-xs border-dashed border-ink-500 bg-ink-100 p-10 text-center text-sm text-paper-muted">Open a pipeline from Overview to manage business metadata.</Card>;
  const set = (key: keyof MetadataDraft, value: string): void => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (): Promise<void> => {
    try {
      await mutations.saveMetadata.mutateAsync({ id: pipelineId, input: draft });
      toast.success("Business metadata saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save metadata");
    }
  };
  return <div className="grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]"><Card className="space-y-3 rounded-xs border-ink-500 bg-ink-100 p-4"><div className="flex items-center gap-2"><BookOpen className="h-4 w-4 text-brand" /><h3 className="font-medium text-paper">Metadata for {pipelineQuery.data?.name}</h3></div><div className="grid grid-cols-2 gap-2"><Field label="Entity"><Select value={draft.entityType} onValueChange={(value) => set("entityType", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pipeline">Pipeline</SelectItem><SelectItem value="table">Table</SelectItem><SelectItem value="column">Column</SelectItem></SelectContent></Select></Field><Field label="Entity key"><Input value={draft.entityKey} onChange={(event) => set("entityKey", event.target.value)} placeholder="raw.PartTran.PartNum" /></Field></div><Field label="Description"><Textarea value={draft.description ?? ""} onChange={(event) => set("description", event.target.value)} /></Field><div className="grid grid-cols-2 gap-2"><Field label="Business owner"><Input value={draft.businessOwner ?? ""} onChange={(event) => set("businessOwner", event.target.value)} /></Field><Field label="Data owner"><Input value={draft.dataOwner ?? ""} onChange={(event) => set("dataOwner", event.target.value)} /></Field><Field label="Sensitivity"><Input value={draft.sensitivity ?? ""} onChange={(event) => set("sensitivity", event.target.value)} placeholder="internal" /></Field><Field label="Source system"><Input value={draft.sourceSystem ?? ""} onChange={(event) => set("sourceSystem", event.target.value)} /></Field></div><Field label="Refresh frequency"><Input value={draft.refreshFrequency ?? ""} onChange={(event) => set("refreshFrequency", event.target.value)} /></Field><Field label="Business definition"><Textarea value={draft.businessDefinition ?? ""} onChange={(event) => set("businessDefinition", event.target.value)} /></Field>{canEdit && <Button onClick={() => void save()} disabled={!draft.entityKey.trim() || mutations.saveMetadata.isPending}><Save className="h-4 w-4" /> Save metadata</Button>}</Card><div className="space-y-2">{metadataQuery.data?.map((item) => <Card key={item.id} className="rounded-xs border-ink-500 bg-ink-100 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">{item.entityType}</p><p className="mt-1 text-sm font-medium text-paper">{item.entityKey}</p><p className="mt-2 whitespace-pre-wrap text-xs text-paper-muted">{item.description || item.businessDefinition || "No description"}</p><p className="mt-2 text-[10px] text-paper-faint">Owner: {item.businessOwner || "—"} · Sensitivity: {item.sensitivity || "—"} · Source: {item.sourceSystem || "—"}</p></div>{canEdit && <Button size="sm" variant="ghost" onClick={() => void mutations.deleteMetadata.mutateAsync({ id: pipelineId, metadataId: item.id }).then(() => toast.success("Metadata deleted")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Delete failed"))}><Trash2 className="h-4 w-4" /></Button>}</div></Card>)}</div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint">{label}</Label>{children}</div>;
}
