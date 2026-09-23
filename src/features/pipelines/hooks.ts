import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  archivePipeline,
  createNextPipelineDraft,
  createPipeline,
  deletePipelineMetadata,
  deployPipeline,
  getPipeline,
  listPipelineDeployments,
  listPipelineMetadata,
  listPipelineRuns,
  listPipelines,
  listPipelineVersions,
  retirePipeline,
  rollbackPipeline,
  runPipeline,
  savePipelineMetadata,
  testPipelineSample,
  updatePipelineDraft,
  validatePipeline,
} from "@/api/pipelines";

export const pipelineKeys = {
  all: ["visual-pipelines"] as const,
  list: () => [...pipelineKeys.all, "list"] as const,
  detail: (id: string) => [...pipelineKeys.all, "detail", id] as const,
  versions: (id: string) => [...pipelineKeys.all, "versions", id] as const,
  deployments: (id: string) => [...pipelineKeys.all, "deployments", id] as const,
  runs: (id: string) => [...pipelineKeys.all, "runs", id] as const,
  metadata: (id: string) => [...pipelineKeys.all, "metadata", id] as const,
};

export function usePipelines() {
  return useQuery({ queryKey: pipelineKeys.list(), queryFn: listPipelines });
}

export function usePipeline(id?: string) {
  return useQuery({
    queryKey: pipelineKeys.detail(id ?? "none"),
    queryFn: () => getPipeline(id ?? ""),
    enabled: Boolean(id),
  });
}

export function usePipelineVersions(id?: string) {
  return useQuery({
    queryKey: pipelineKeys.versions(id ?? "none"),
    queryFn: () => listPipelineVersions(id ?? ""),
    enabled: Boolean(id),
  });
}

export function usePipelineDeployments(id?: string) {
  return useQuery({
    queryKey: pipelineKeys.deployments(id ?? "none"),
    queryFn: () => listPipelineDeployments(id ?? ""),
    enabled: Boolean(id),
  });
}

export function usePipelineRuns(id?: string) {
  return useQuery({
    queryKey: pipelineKeys.runs(id ?? "none"),
    queryFn: () => listPipelineRuns(id ?? ""),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });
}

export function usePipelineMetadata(id?: string) {
  return useQuery({
    queryKey: pipelineKeys.metadata(id ?? "none"),
    queryFn: () => listPipelineMetadata(id ?? ""),
    enabled: Boolean(id),
  });
}

export function usePipelineMutations() {
  const queryClient = useQueryClient();
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: pipelineKeys.all });
  };
  return {
    create: useMutation({ mutationFn: createPipeline, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updatePipelineDraft>[1] }) => updatePipelineDraft(id, input),
      onSuccess: refresh,
    }),
    newDraft: useMutation({ mutationFn: createNextPipelineDraft, onSuccess: refresh }),
    validate: useMutation({ mutationFn: validatePipeline, onSuccess: refresh }),
    test: useMutation({ mutationFn: ({ id, limit }: { id: string; limit?: number }) => testPipelineSample(id, limit), onSuccess: refresh }),
    archive: useMutation({ mutationFn: archivePipeline, onSuccess: refresh }),
    deploy: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Parameters<typeof deployPipeline>[1] }) => deployPipeline(id, input),
      onSuccess: refresh,
    }),
    rollback: useMutation({
      mutationFn: ({ id, deploymentId }: { id: string; deploymentId: string }) => rollbackPipeline(id, deploymentId),
      onSuccess: refresh,
    }),
    run: useMutation({ mutationFn: runPipeline, onSuccess: refresh }),
    retire: useMutation({ mutationFn: retirePipeline, onSuccess: refresh }),
    saveMetadata: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Parameters<typeof savePipelineMetadata>[1] }) => savePipelineMetadata(id, input),
      onSuccess: refresh,
    }),
    deleteMetadata: useMutation({
      mutationFn: ({ id, metadataId }: { id: string; metadataId: string }) => deletePipelineMetadata(id, metadataId),
      onSuccess: refresh,
    }),
  };
}
