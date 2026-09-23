import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, { Background, Controls, MarkerType, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { CheckCircle2, Code2, FlaskConical, Loader2, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { getDatabases } from "@/api/explorer";
import { getPipelineSchemaMapping, type PipelineDefinition, type PipelineNode, type PipelineSampleResult, type VisualPipelineDetail } from "@/api/pipelines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuthStore, useRbacStore, RBAC_PERMISSIONS } from "@/stores";
import { cn } from "@/lib/utils";
import { usePipeline, usePipelineMutations } from "./hooks";

interface DesignerFields {
  name: string;
  description: string;
  sourceDatabase: string;
  sourceTable: string;
  filterColumn: string;
  filterValue: string;
  selectedColumns: string;
  castColumn: string;
  castType: "String" | "Int64" | "Float64" | "Date" | "DateTime";
  destinationDatabase: string;
  destinationTable: string;
  writeMode: "append" | "replace" | "upsert";
}

const EMPTY_FIELDS: DesignerFields = {
  name: "",
  description: "",
  sourceDatabase: "",
  sourceTable: "",
  filterColumn: "",
  filterValue: "",
  selectedColumns: "",
  castColumn: "",
  castType: "String",
  destinationDatabase: "",
  destinationTable: "",
  writeMode: "append",
};

function fieldsFromPipeline(pipeline: VisualPipelineDetail): DesignerFields {
  const nodes = pipeline.draft?.definition.nodes ?? [];
  const source = nodes.find((node) => node.type === "source");
  const filter = nodes.find((node) => node.type === "filter");
  const select = nodes.find((node) => node.type === "select");
  const cast = nodes.find((node) => node.type === "cast");
  const destination = nodes.find((node) => node.type === "destination");
  const expression = filter?.type === "filter" ? filter.config.expression : undefined;
  const simpleFilter = expression?.kind === "binary" && expression.operator === "eq" ? expression : undefined;
  const left = simpleFilter?.left.kind === "column" ? simpleFilter.left.name : "";
  const right = simpleFilter?.right.kind === "literal" ? String(simpleFilter.right.value ?? "") : "";
  return {
    name: pipeline.name,
    description: pipeline.description ?? "",
    sourceDatabase: source?.type === "source" ? source.config.database : "",
    sourceTable: source?.type === "source" ? source.config.table : "",
    filterColumn: left,
    filterValue: right,
    selectedColumns: select?.type === "select"
      ? select.config.columns.map((column) => column.alias ? `${column.source}:${column.alias}` : column.source).join(", ")
      : "",
    castColumn: cast?.type === "cast" ? cast.config.columns[0]?.column ?? "" : "",
    castType: cast?.type === "cast" && ["String", "Int64", "Float64", "Date", "DateTime"].includes(cast.config.columns[0]?.dataType)
      ? cast.config.columns[0].dataType as DesignerFields["castType"]
      : "String",
    destinationDatabase: destination?.type === "destination" ? destination.config.database : "",
    destinationTable: destination?.type === "destination" ? destination.config.table : "",
    writeMode: destination?.type === "destination" ? destination.config.writeMode : "append",
  };
}

function selectedColumns(value: string): Array<{ source: string; alias?: string }> {
  return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [source, alias] = part.split(":").map((token) => token.trim());
    return alias ? { source, alias } : { source };
  });
}

function buildDefinition(fields: DesignerFields): PipelineDefinition {
  const nodes: PipelineNode[] = [];
  const edges: PipelineDefinition["edges"] = [];
  const add = (node: PipelineNode): void => {
    const previous = nodes[nodes.length - 1];
    nodes.push(node);
    if (previous) edges.push({ id: `edge_${edges.length + 1}`, from: previous.id, to: node.id, input: "main" });
  };
  add({ id: "source_main", type: "source", position: { x: 0, y: 80 }, config: { database: fields.sourceDatabase, table: fields.sourceTable } });
  if (fields.filterColumn.trim() && fields.filterValue.trim()) {
    add({
      id: "filter_main",
      type: "filter",
      position: { x: nodes.length * 240, y: 80 },
      config: {
        expression: {
          kind: "binary",
          operator: "eq",
          left: { kind: "column", name: fields.filterColumn.trim() },
          right: { kind: "literal", value: fields.filterValue, dataType: "String" },
        },
      },
    });
  }
  const selection = selectedColumns(fields.selectedColumns);
  if (selection.length > 0) {
    add({ id: "select_main", type: "select", position: { x: nodes.length * 240, y: 80 }, config: { columns: selection } });
  }
  if (fields.castColumn.trim()) {
    add({ id: "cast_main", type: "cast", position: { x: nodes.length * 240, y: 80 }, config: { columns: [{ column: fields.castColumn.trim(), dataType: fields.castType }] } });
  }
  add({
    id: "destination_main",
    type: "destination",
    position: { x: nodes.length * 240, y: 80 },
    config: { database: fields.destinationDatabase, table: fields.destinationTable, writeMode: fields.writeMode },
  });
  return { schemaVersion: 1, nodes, edges };
}

function flowElements(definition: PipelineDefinition): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: { label: `${node.type.toUpperCase()}\n${node.type === "source" || node.type === "destination" ? `${node.config.database}.${node.config.table}` : node.id}` },
      style: { background: "#171717", color: "#f5f5f5", border: "1px solid #404040", borderRadius: 3, width: 180, whiteSpace: "pre-line", fontSize: 12 },
    })),
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#818cf8" },
    })),
  };
}

interface PipelineDesignerProps {
  pipelineId?: string;
  onPipelineChange: (id?: string) => void;
}

export function PipelineDesigner({ pipelineId, onPipelineChange }: PipelineDesignerProps) {
  const activeConnectionId = useAuthStore((state) => state.activeConnectionId);
  const { hasPermission } = useRbacStore();
  const canEdit = hasPermission(RBAC_PERMISSIONS.PIPELINES_EDIT);
  const canValidate = hasPermission(RBAC_PERMISSIONS.PIPELINES_TEST);
  const pipelineQuery = usePipeline(pipelineId);
  const databasesQuery = useQuery({ queryKey: ["pipeline-databases", activeConnectionId], queryFn: getDatabases, enabled: Boolean(activeConnectionId) });
  const schemaMappingQuery = useQuery({
    queryKey: ["visual-pipelines", "schema-mapping", pipelineId],
    queryFn: () => getPipelineSchemaMapping(pipelineId ?? ""),
    enabled: Boolean(pipelineId && pipelineQuery.data?.draft?.outputSchema),
  });
  const mutations = usePipelineMutations();
  const [fields, setFields] = useState<DesignerFields>(EMPTY_FIELDS);
  const [sample, setSample] = useState<PipelineSampleResult | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [definitionText, setDefinitionText] = useState("");

  useEffect(() => {
    if (pipelineQuery.data) {
      setFields(fieldsFromPipeline(pipelineQuery.data));
      const storedDefinition = pipelineQuery.data.draft?.definition;
      if (storedDefinition) {
        setDefinitionText(JSON.stringify(storedDefinition, null, 2));
        const advanced = storedDefinition.nodes.filter((node) => node.type === "source").length > 1
          || storedDefinition.nodes.some((node) => !["source", "filter", "select", "cast", "destination"].includes(node.type));
        setAdvancedMode(advanced);
      }
    } else if (!pipelineId) {
      setFields(EMPTY_FIELDS);
      setAdvancedMode(false);
      setDefinitionText("");
    }
  }, [pipelineId, pipelineQuery.data]);

  const definition = useMemo<PipelineDefinition | null>(() => {
    if (!advancedMode) return buildDefinition(fields);
    try {
      const parsed = JSON.parse(definitionText) as PipelineDefinition;
      return parsed?.schemaVersion === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? parsed : null;
    } catch {
      return null;
    }
  }, [advancedMode, definitionText, fields]);
  const graph = useMemo(() => flowElements(definition ?? { schemaVersion: 1, nodes: [], edges: [] }), [definition]);
  const tables = databasesQuery.data?.find((database) => database.name === fields.sourceDatabase)?.children ?? [];
  const immutable = Boolean(pipelineQuery.data?.draft && pipelineQuery.data.draft.status !== "DRAFT");

  const set = <K extends keyof DesignerFields>(key: K, value: DesignerFields[K]): void => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const save = async (): Promise<string | undefined> => {
    if (!activeConnectionId) {
      toast.error("Select a ClickHouse connection first");
      return undefined;
    }
    if (!fields.name.trim() || (!advancedMode && (!fields.sourceDatabase || !fields.sourceTable || !fields.destinationDatabase || !fields.destinationTable))) {
      toast.error(advancedMode ? "Name is required" : "Name, source, and destination are required");
      return undefined;
    }
    if (!definition) {
      toast.error("Advanced DAG JSON is invalid");
      return undefined;
    }
    try {
      if (pipelineId) {
        await mutations.update.mutateAsync({ id: pipelineId, input: { name: fields.name, description: fields.description || null, definition } });
        toast.success("Pipeline draft saved");
        return pipelineId;
      }
      const created = await mutations.create.mutateAsync({
        name: fields.name,
        description: fields.description || null,
        connectionId: activeConnectionId,
        definition,
      });
      onPipelineChange(created.id);
      toast.success("Pipeline draft created");
      return created.id;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save pipeline");
      return undefined;
    }
  };

  const validate = async (): Promise<void> => {
    const id = pipelineId ?? await save();
    if (!id) return;
    try {
      await mutations.validate.mutateAsync(id);
      toast.success("Pipeline validated and version frozen");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Pipeline validation failed");
    }
  };

  const createNextDraft = async (): Promise<void> => {
    if (!pipelineId) return;
    try {
      await mutations.newDraft.mutateAsync(pipelineId);
      setSample(null);
      toast.success("New editable pipeline version created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the next draft");
    }
  };

  const testSample = async (): Promise<void> => {
    if (!pipelineId) return;
    try {
      const result = await mutations.test.mutateAsync({ id: pipelineId, limit: 100 });
      setSample(result);
      toast.success(`Sample returned ${result.rows.length} row(s)`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sample test failed");
    }
  };

  return (
    <div className="grid min-h-[650px] grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="space-y-4 rounded-xs border-ink-500 bg-ink-100 p-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-faint">Pipeline definition</p>
          <h2 className="mt-1 text-base font-semibold text-paper">Visual transform</h2>
        </div>
        <Field label="Name"><Input value={fields.name} onChange={(event) => set("name", event.target.value)} disabled={immutable} /></Field>
        <Field label="Description"><Textarea value={fields.description} onChange={(event) => set("description", event.target.value)} disabled={immutable} /></Field>
        {!immutable && <Button type="button" variant="outline" size="sm" onClick={() => {
          if (!advancedMode) setDefinitionText(JSON.stringify(buildDefinition(fields), null, 2));
          setAdvancedMode((current) => !current);
        }}><Code2 className="h-4 w-4" /> {advancedMode ? "Guided editor" : "Advanced DAG JSON"}</Button>}
        {advancedMode && !immutable && <Field label="Versioned pipeline definition"><Textarea className="min-h-[420px] font-mono text-xs" value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} spellCheck={false} /><p className="text-[10px] leading-4 text-paper-faint">Supports multiple sources plus calculated, join, union, deduplicate, aggregate, sort, window, and multi-port edges. Save validates the complete schema on the server.</p></Field>}
        {!advancedMode && <>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Source database">
            <Select value={fields.sourceDatabase} onValueChange={(value) => { set("sourceDatabase", value); set("sourceTable", ""); }} disabled={immutable}>
              <SelectTrigger><SelectValue placeholder="Database" /></SelectTrigger>
              <SelectContent>{databasesQuery.data?.map((database) => <SelectItem key={database.name} value={database.name}>{database.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Source table">
            <Select value={fields.sourceTable} onValueChange={(value) => set("sourceTable", value)} disabled={immutable || !fields.sourceDatabase}>
              <SelectTrigger><SelectValue placeholder="Table" /></SelectTrigger>
              <SelectContent>{tables.map((table) => <SelectItem key={table.name} value={table.name}>{table.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Filter column"><Input value={fields.filterColumn} onChange={(event) => set("filterColumn", event.target.value)} placeholder="Company" disabled={immutable} /></Field>
          <Field label="Equals"><Input value={fields.filterValue} onChange={(event) => set("filterValue", event.target.value)} placeholder="VN" disabled={immutable} /></Field>
        </div>
        <Field label="Select / rename"><Input value={fields.selectedColumns} onChange={(event) => set("selectedColumns", event.target.value)} placeholder="Company, PartNum:PartNumber" disabled={immutable} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Cast column"><Input value={fields.castColumn} onChange={(event) => set("castColumn", event.target.value)} placeholder="SysDate" disabled={immutable} /></Field>
          <Field label="Target type">
            <Select value={fields.castType} onValueChange={(value) => set("castType", value as DesignerFields["castType"])} disabled={immutable}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{["String", "Int64", "Float64", "Date", "DateTime"].map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Destination database"><Input value={fields.destinationDatabase} onChange={(event) => set("destinationDatabase", event.target.value)} placeholder="ods" disabled={immutable} /></Field>
          <Field label="Destination table"><Input value={fields.destinationTable} onChange={(event) => set("destinationTable", event.target.value)} placeholder="PartTran" disabled={immutable} /></Field>
        </div>
        <Field label="Write mode">
          <Select value={fields.writeMode} onValueChange={(value) => set("writeMode", value as DesignerFields["writeMode"])} disabled={immutable}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="append">Append</SelectItem><SelectItem value="replace">Replace</SelectItem><SelectItem value="upsert">Upsert</SelectItem></SelectContent>
          </Select>
        </Field>
        </>}
        <div className="flex gap-2">
          {canEdit && !immutable && <Button onClick={() => void save()} disabled={mutations.create.isPending || mutations.update.isPending}><Save className="h-4 w-4" /> Save draft</Button>}
          {canValidate && !immutable && <Button variant="outline" onClick={() => void validate()} disabled={mutations.validate.isPending}><ShieldCheck className="h-4 w-4" /> Validate</Button>}
        </div>
        {immutable && (
          <div className="space-y-3 rounded-xs border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Version {pipelineQuery.data?.draft?.versionNumber} is {pipelineQuery.data?.draft?.status.toLowerCase()} and immutable.</div>
            {canValidate && ["VALIDATED", "TESTED"].includes(pipelineQuery.data?.draft?.status ?? "") && <Button size="sm" variant="outline" onClick={() => void testSample()} disabled={mutations.test.isPending}><FlaskConical className="h-4 w-4" /> Test sample</Button>}
            {canEdit && <Button size="sm" variant="outline" onClick={() => void createNextDraft()} disabled={mutations.newDraft.isPending}>Create next draft</Button>}
          </div>
        )}
      </Card>

      <div className="grid min-h-0 grid-rows-[minmax(360px,1fr)_auto] gap-4">
        <Card className="relative overflow-hidden rounded-xs border-ink-500 bg-ink-50">
          {pipelineQuery.isLoading && <Loader2 className="absolute right-4 top-4 z-10 h-4 w-4 animate-spin text-paper-muted" />}
          <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView minZoom={0.35} maxZoom={1.5}>
            <Background color="#303030" gap={20} />
            <Controls />
          </ReactFlow>
        </Card>
        {pipelineQuery.data?.draft?.generatedSql && (
          <Card className="rounded-xs border-ink-500 bg-ink-100 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-paper-faint">Generated SQL</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xs bg-ink-50 p-3 font-mono text-xs text-paper-muted">{pipelineQuery.data.draft.generatedSql}</pre>
          </Card>
        )}
        {sample && (
          <Card className="rounded-xs border-ink-500 bg-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-faint">Read-only sample</p>
              <span className="font-mono text-[10px] text-paper-faint">{sample.rows.length} row(s){sample.truncated ? " · limited" : ""}</span>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre rounded-xs bg-ink-50 p-3 font-mono text-xs text-paper-muted">{JSON.stringify(sample.rows, null, 2)}</pre>
          </Card>
        )}
        {schemaMappingQuery.data && (
          <Card className="rounded-xs border-ink-500 bg-ink-100 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-paper-faint">Schema mapping</p>
            <div className="space-y-1.5">
              {schemaMappingQuery.data.mapping.map((item) => <div key={item.source.name} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xs bg-ink-50 px-3 py-2 font-mono text-xs"><span className="text-paper-muted">{item.source.name} <span className="text-paper-faint">{item.source.type}</span></span><span className={item.status === "matched" ? "text-emerald-400" : "text-amber-400"}>{item.status === "matched" ? "✓" : "⚠"}</span><span className="text-paper-muted">{item.destination ? `${item.destination.name} ${item.destination.type}` : "No matching destination column"}{item.suggestedCast ? ` · cast to ${item.suggestedCast}` : ""}</span></div>)}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className={cn("space-y-1.5")}><Label className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint">{label}</Label>{children}</div>;
}
