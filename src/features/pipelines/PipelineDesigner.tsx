import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronsUpDown, Code2, FlaskConical, Loader2, Save, ShieldCheck, X } from "lucide-react";
import ReactFlow, { Background, Controls, MarkerType, type Edge, type Node } from "reactflow";
import "reactflow/dist/style.css";
import { toast } from "sonner";

import { getDatabases, getTableDetails } from "@/api/explorer";
import type { ColumnInfo } from "@/api/explorer";
import { getPipelineSchemaMapping } from "@/api/pipelines";
import type { PipelineDefinition, PipelineSampleResult } from "@/api/pipelines";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { RBAC_PERMISSIONS, useAuthStore, useRbacStore } from "@/stores";
import {
  buildDefinition,
  EMPTY_FIELDS,
  fieldsFromPipeline,
  FILTER_OPERATORS,
  literalInputType,
  PIPELINE_CAST_TYPES,
  projectedColumns,
  validateGuidedFields,
} from "./designerModel";
import type { DesignerFields, DestinationMode, FilterOperator } from "./designerModel";
import { usePipeline, usePipelineMutations } from "./hooks";

const FILTER_LABELS: Record<FilterOperator, string> = {
  eq: "Equals",
  neq: "Does not equal",
  gt: "Greater than",
  gte: "Greater than or equal",
  lt: "Less than",
  lte: "Less than or equal",
};

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

interface ColumnPickerProps {
  columns: ColumnInfo[];
  selected: string[];
  disabled: boolean;
  onChange: (columns: string[]) => void;
}

function ColumnPicker({ columns, selected, disabled, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const selectedColumns = columns.filter((column) => selected.includes(column.name));
  const toggle = (column: string): void => {
    onChange(selected.includes(column) ? selected.filter((value) => value !== column) : [...selected, column]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex min-h-9 w-full items-center justify-between gap-2 rounded-xs border border-ink-500 bg-ink-50 px-3 py-1.5 text-left text-[12px] text-paper hover:border-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex flex-1 flex-wrap gap-1.5">
            {selectedColumns.length === 0 ? (
              <span className="text-paper-faint">All source columns</span>
            ) : selectedColumns.map((column) => (
              <span key={column.name} className="inline-flex items-center gap-1 rounded-xs border border-ink-500 bg-ink-200 px-1.5 py-0.5 font-mono text-[10px]">
                {column.name}
                <X
                  className="h-3 w-3 text-paper-faint hover:text-paper"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(column.name);
                  }}
                />
              </span>
            ))}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-paper-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] rounded-xs border-ink-500 bg-ink-100 p-1">
        {columns.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-paper-muted">Choose a source table first</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {columns.map((column) => {
              const checked = selected.includes(column.name);
              return (
                <li key={column.name}>
                  <button type="button" onClick={() => toggle(column.name)} className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-[12px] text-paper hover:bg-ink-200">
                    <span className={cn("grid h-4 w-4 place-items-center rounded-xs border", checked ? "border-brand bg-brand text-ink-50" : "border-ink-500 bg-ink-200")}>
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{column.name}</span>
                    <span className="font-mono text-[10px] text-paper-faint">{column.type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
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
  const databasesQuery = useQuery({
    queryKey: ["pipeline-databases", activeConnectionId],
    queryFn: getDatabases,
    enabled: Boolean(activeConnectionId),
  });
  const mutations = usePipelineMutations();
  const [fields, setFields] = useState<DesignerFields>(EMPTY_FIELDS);
  const [sample, setSample] = useState<PipelineSampleResult | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [definitionText, setDefinitionText] = useState("");

  const sourceColumnsQuery = useQuery({
    queryKey: ["pipeline-source-columns", activeConnectionId, fields.sourceDatabase, fields.sourceTable],
    queryFn: () => getTableDetails(fields.sourceDatabase, fields.sourceTable),
    enabled: Boolean(activeConnectionId && fields.sourceDatabase && fields.sourceTable),
  });
  const sourceColumns = sourceColumnsQuery.data?.columns ?? [];
  const schemaMappingQuery = useQuery({
    queryKey: ["visual-pipelines", "schema-mapping", pipelineId],
    queryFn: () => getPipelineSchemaMapping(pipelineId ?? ""),
    enabled: Boolean(pipelineId && pipelineQuery.data?.draft?.outputSchema),
  });

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
    if (!advancedMode) return buildDefinition(fields, sourceColumns);
    try {
      const parsed = JSON.parse(definitionText) as PipelineDefinition;
      return parsed?.schemaVersion === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? parsed : null;
    } catch {
      return null;
    }
  }, [advancedMode, definitionText, fields, sourceColumns]);
  const graph = useMemo(() => flowElements(definition ?? { schemaVersion: 1, nodes: [], edges: [] }), [definition]);
  const sourceTables = databasesQuery.data?.find((database) => database.name === fields.sourceDatabase)?.children ?? [];
  const destinationDatabases = databasesQuery.data?.filter((database) => database.name !== "system") ?? [];
  const destinationTables = destinationDatabases.find((database) => database.name === fields.destinationDatabase)?.children ?? [];
  const castColumns = useMemo(() => projectedColumns(fields, sourceColumns), [fields, sourceColumns]);
  const filterColumn = sourceColumns.find((column) => column.name === fields.filterColumn);
  const filterInputType = filterColumn ? literalInputType(filterColumn.type) : "text";
  const immutable = Boolean(pipelineQuery.data?.draft && pipelineQuery.data.draft.status !== "DRAFT");

  const set = <K extends keyof DesignerFields>(key: K, value: DesignerFields[K]): void => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const setSourceDatabase = (database: string): void => {
    setFields((current) => ({
      ...current,
      sourceDatabase: database,
      sourceTable: "",
      filterColumn: "",
      filterValue: "",
      selectedColumns: [],
      columnAliases: {},
      castColumn: "",
    }));
  };

  const setSourceTable = (table: string): void => {
    setFields((current) => ({
      ...current,
      sourceTable: table,
      filterColumn: "",
      filterValue: "",
      selectedColumns: [],
      columnAliases: {},
      castColumn: "",
    }));
  };

  const setSelectedColumns = (selectedColumns: string[]): void => {
    setFields((current) => {
      const columnAliases = Object.fromEntries(Object.entries(current.columnAliases).filter(([column]) => selectedColumns.includes(column)));
      const next = { ...current, selectedColumns, columnAliases };
      const outputNames = new Set(projectedColumns(next, sourceColumns).map((column) => column.name));
      return { ...next, castColumn: outputNames.has(current.castColumn) ? current.castColumn : "" };
    });
  };

  const setAlias = (source: string, alias: string): void => {
    setFields((current) => {
      const previousOutput = current.columnAliases[source]?.trim() || source;
      const nextOutput = alias.trim() || source;
      return {
        ...current,
        columnAliases: { ...current.columnAliases, [source]: alias },
        castColumn: current.castColumn === previousOutput ? nextOutput : current.castColumn,
      };
    });
  };

  const setDestinationMode = (destinationMode: DestinationMode): void => {
    setFields((current) => ({
      ...current,
      destinationMode,
      destinationTable: "",
      writeMode: destinationMode === "new" ? "append" : current.writeMode,
    }));
  };

  const save = async (): Promise<string | undefined> => {
    if (!activeConnectionId) {
      toast.error("Select a ClickHouse connection first");
      return undefined;
    }
    if (advancedMode && !fields.name.trim()) {
      toast.error("Pipeline name is required");
      return undefined;
    }
    if (!advancedMode) {
      if (sourceColumnsQuery.isFetching) {
        toast.error("Wait for the source schema to finish loading");
        return undefined;
      }
      const validationError = validateGuidedFields(fields, sourceColumns, {
        databases: destinationDatabases.map((database) => database.name),
        tables: destinationTables.map((table) => table.name),
      });
      if (validationError) {
        toast.error(validationError);
        return undefined;
      }
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
    <div className="grid min-h-[650px] grid-cols-1 gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
      <Card className="space-y-4 rounded-xs border-ink-500 bg-ink-100 p-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-paper-faint">Pipeline definition</p>
          <h2 className="mt-1 text-base font-semibold text-paper">Visual transform</h2>
        </div>
        {immutable && (
          <div className="rounded-xs border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <p className="font-medium">This version is locked after validation/test.</p>
            <p className="mt-1 text-amber-100/70">Create the next draft to edit it. The deployed artifact stays unchanged.</p>
            {canEdit && <Button className="mt-2" size="sm" variant="outline" onClick={() => void createNextDraft()} disabled={mutations.newDraft.isPending}>Create editable draft</Button>}
          </div>
        )}
        <Field label="Name"><Input value={fields.name} onChange={(event) => set("name", event.target.value)} disabled={immutable} /></Field>
        <Field label="Description"><Textarea value={fields.description} onChange={(event) => set("description", event.target.value)} disabled={immutable} /></Field>
        {!immutable && <Button type="button" variant="outline" size="sm" onClick={() => {
          if (!advancedMode) setDefinitionText(JSON.stringify(buildDefinition(fields, sourceColumns), null, 2));
          setAdvancedMode((current) => !current);
        }}><Code2 className="h-4 w-4" /> {advancedMode ? "Guided editor" : "Advanced DAG JSON"}</Button>}
        {advancedMode && !immutable && <Field label="Versioned pipeline definition"><Textarea className="min-h-[420px] font-mono text-xs" value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} spellCheck={false} /><p className="text-[10px] leading-4 text-paper-faint">Supports multiple sources, join/union, deduplicate, aggregate, sort, window, and calculated expressions. Function transforms include lower, upper, trim, length, abs, round, toDate, toDateTime, concat, coalesce, and ifNull. Raw SQL is intentionally not accepted; save validates the complete schema on the server.</p></Field>}
        {!advancedMode && <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Source database">
              <Select value={fields.sourceDatabase} onValueChange={setSourceDatabase} disabled={immutable || databasesQuery.isPending}>
                <SelectTrigger><SelectValue placeholder="Choose database" /></SelectTrigger>
                <SelectContent>{databasesQuery.data?.map((database) => <SelectItem key={database.name} value={database.name}>{database.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Source table">
              <Select value={fields.sourceTable} onValueChange={setSourceTable} disabled={immutable || !fields.sourceDatabase}>
                <SelectTrigger><SelectValue placeholder="Choose table" /></SelectTrigger>
                <SelectContent>{sourceTables.map((table) => <SelectItem key={table.name} value={table.name}>{table.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
          {sourceColumnsQuery.isFetching && <p className="flex items-center gap-2 text-[10px] text-paper-faint"><Loader2 className="h-3 w-3 animate-spin" /> Loading source schema</p>}
          {sourceColumnsQuery.isError && <p className="text-[11px] text-red-400">Could not load columns for the selected source table.</p>}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Filter column">
              <Select
                value={fields.filterColumn || "__none__"}
                onValueChange={(value) => {
                  const filterColumn = value === "__none__" ? "" : value;
                  const column = sourceColumns.find((candidate) => candidate.name === filterColumn);
                  setFields((current) => ({
                    ...current,
                    filterColumn,
                    filterValue: column && literalInputType(column.type) === "boolean" ? "true" : "",
                  }));
                }}
                disabled={immutable || sourceColumns.length === 0}
              >
                <SelectTrigger><SelectValue placeholder="No filter" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No filter</SelectItem>
                  {sourceColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name} · {column.type}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {fields.filterColumn && <Field label="Operator">
              <Select value={fields.filterOperator} onValueChange={(value) => set("filterOperator", value as FilterOperator)} disabled={immutable}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{FILTER_OPERATORS.map((operator) => <SelectItem key={operator} value={operator}>{FILTER_LABELS[operator]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>}
          </div>
          {fields.filterColumn && <Field label="Filter value">
            {filterInputType === "boolean" ? (
              <Select value={fields.filterValue || "true"} onValueChange={(value) => set("filterValue", value)} disabled={immutable}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="true">True</SelectItem><SelectItem value="false">False</SelectItem></SelectContent>
              </Select>
            ) : (
              <Input
                type={filterInputType}
                step={filterInputType === "number" ? "any" : undefined}
                value={fields.filterValue}
                onChange={(event) => set("filterValue", event.target.value)}
                placeholder={`Value for ${fields.filterColumn}`}
                disabled={immutable}
              />
            )}
          </Field>}

          <Field label="Select / rename columns">
            <ColumnPicker columns={sourceColumns} selected={fields.selectedColumns} onChange={setSelectedColumns} disabled={immutable || sourceColumns.length === 0} />
            <p className="text-[10px] text-paper-faint">Leave empty to keep every source column.</p>
          </Field>
          {fields.selectedColumns.length > 0 && (
            <div className="space-y-2 rounded-xs border border-ink-500 bg-ink-50 p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">Optional output names</p>
              {fields.selectedColumns.map((column) => (
                <div key={column} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                  <span className="truncate font-mono text-[11px] text-paper-muted">{column}</span>
                  <Input value={fields.columnAliases[column] ?? ""} onChange={(event) => setAlias(column, event.target.value)} placeholder="Keep original name" disabled={immutable} />
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Cast column">
              <Select value={fields.castColumn || "__none__"} onValueChange={(value) => set("castColumn", value === "__none__" ? "" : value)} disabled={immutable || castColumns.length === 0}>
                <SelectTrigger><SelectValue placeholder="No cast" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No cast</SelectItem>
                  {castColumns.map((column) => <SelectItem key={column.name} value={column.name}>{column.name} · {column.type}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {fields.castColumn && <Field label="Target type">
              <Select value={fields.castType} onValueChange={(value) => set("castType", value as DesignerFields["castType"])} disabled={immutable}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PIPELINE_CAST_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
              </Select>
            </Field>}
          </div>

          <Field label="Destination mode">
            <Select value={fields.destinationMode} onValueChange={(value) => setDestinationMode(value as DestinationMode)} disabled={immutable}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="existing">Use existing table</SelectItem><SelectItem value="new">Create new table</SelectItem></SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Destination database">
              <Select
                value={fields.destinationDatabase}
                onValueChange={(value) => setFields((current) => ({ ...current, destinationDatabase: value, destinationTable: "" }))}
                disabled={immutable || databasesQuery.isPending}
              >
                <SelectTrigger><SelectValue placeholder="Choose database" /></SelectTrigger>
                <SelectContent>{destinationDatabases.map((database) => <SelectItem key={database.name} value={database.name}>{database.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={fields.destinationMode === "new" ? "New table name" : "Destination table"}>
              {fields.destinationMode === "new" ? (
                <Input value={fields.destinationTable} onChange={(event) => set("destinationTable", event.target.value)} placeholder="sales_summary_v2" disabled={immutable || !fields.destinationDatabase} />
              ) : (
                <Select value={fields.destinationTable} onValueChange={(value) => set("destinationTable", value)} disabled={immutable || !fields.destinationDatabase}>
                  <SelectTrigger><SelectValue placeholder="Choose table" /></SelectTrigger>
                  <SelectContent>{destinationTables.map((table) => <SelectItem key={table.name} value={table.name}>{table.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
            </Field>
          </div>
          {fields.destinationMode === "new" && <p className="text-[10px] leading-4 text-paper-faint">The table is created as MergeTree from the validated output schema when the pipeline is deployed.</p>}
          <Field label="Write mode">
            <Select value={fields.writeMode} onValueChange={(value) => set("writeMode", value as DesignerFields["writeMode"])} disabled={immutable || fields.destinationMode === "new"}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="append">Append</SelectItem>
                {fields.destinationMode === "existing" && <SelectItem value="replace">Replace</SelectItem>}
                {fields.destinationMode === "existing" && <SelectItem value="upsert">Upsert</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
        </>}
        <div className="flex gap-2">
          {canEdit && !immutable && <Button onClick={() => void save()} disabled={mutations.create.isPending || mutations.update.isPending || (!advancedMode && sourceColumnsQuery.isFetching)}><Save className="h-4 w-4" /> Save draft</Button>}
          {canValidate && !immutable && <Button variant="outline" onClick={() => void validate()} disabled={mutations.validate.isPending || (!advancedMode && sourceColumnsQuery.isFetching)}><ShieldCheck className="h-4 w-4" /> Validate</Button>}
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
              {schemaMappingQuery.data.mapping.map((item) => <div key={item.source.name} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xs bg-ink-50 px-3 py-2 font-mono text-xs"><span className="text-paper-muted">{item.source.name} <span className="text-paper-faint">{item.source.type}</span></span><span className={item.status === "matched" || item.status === "will_create" ? "text-emerald-400" : "text-amber-400"}>{item.status === "will_create" ? "+" : item.status === "matched" ? "✓" : "⚠"}</span><span className="text-paper-muted">{item.status === "will_create" ? `${item.source.name} ${item.source.type} · create on deploy` : item.destination ? `${item.destination.name} ${item.destination.type}` : "No matching destination column"}{item.suggestedCast ? ` · cast to ${item.suggestedCast}` : ""}</span></div>)}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="font-mono text-[10px] uppercase tracking-[0.12em] text-paper-faint">{label}</Label>{children}</div>;
}
