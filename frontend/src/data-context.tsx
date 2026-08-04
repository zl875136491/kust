/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type {
  Cluster,
  CreateClusterPayload,
  Overview,
  ResourceListResponse,
  ResourceRow,
  UpdateClusterPayload,
} from './types';
import { useAuth } from './auth-context';

interface DataContextValue {
  clusters: Cluster[];
  loadingClusters: boolean;
  clusterError?: string;
  refreshClusters: () => Promise<void>;
  createCluster: (payload: CreateClusterPayload) => Promise<Cluster>;
  updateCluster: (clusterId: string, payload: UpdateClusterPayload) => Promise<Cluster>;
  deleteCluster: (clusterId: string) => Promise<void>;
  getOverview: (clusterId: string) => Promise<Overview>;
  getResources: (clusterId: string, kind: string, namespace?: string) => Promise<ResourceListResponse>;
  deleteResource: (clusterId: string, kind: string, row: ResourceRow) => Promise<void>;
  getResourceYaml: (clusterId: string, kind: string, row: ResourceRow) => Promise<string>;
  scaleDeployment: (clusterId: string, namespace: string, name: string, replicas: number) => Promise<ResourceRow>;
  getPodLogs: (clusterId: string, namespace: string, name: string, container?: string) => Promise<string>;
  applyYaml: (clusterId: string, yaml: string, namespace?: string) => Promise<{ kind: string; name: string; namespace?: string }>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { user, next } = useAuth();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const [clusterError, setClusterError] = useState<string>();

  const refreshClusters = useCallback(async () => {
    setLoadingClusters(true);
    try {
      setClusters(await api.clusters());
      setClusterError(undefined);
    } catch (error) {
      setClusterError(error instanceof Error ? error.message : '无法连接后端');
    } finally {
      setLoadingClusters(false);
    }
  }, []);

  useEffect(() => {
    if (user && next === 'authenticated') {
      void refreshClusters();
    } else {
      setClusters([]);
      setClusterError(undefined);
      setLoadingClusters(false);
    }
  }, [next, refreshClusters, user]);

  const createCluster = useCallback(async (payload: CreateClusterPayload) => {
    const cluster = await api.createCluster(payload);
    setClusters((current) => [...current, cluster]);
    return cluster;
  }, []);

  const deleteCluster = useCallback(async (clusterId: string) => {
    const target = clusters.find((cluster) => cluster.id === clusterId);
    if (target?.readOnly || target?.preset) throw new Error('预设集群配置为只读，无法移除');
    await api.deleteCluster(clusterId);
    setClusters((current) => current.filter((cluster) => cluster.id !== clusterId));
  }, [clusters]);

  const updateCluster = useCallback(async (clusterId: string, payload: UpdateClusterPayload) => {
    const target = clusters.find((cluster) => cluster.id === clusterId);
    if (!target || target.readOnly || target.preset) throw new Error('预设集群配置为只读，无法编辑');
    const updated = await api.updateCluster(clusterId, payload);
    setClusters((current) => current.map((cluster) => cluster.id === clusterId ? updated : cluster));
    return updated;
  }, [clusters]);

  const getOverview = useCallback((clusterId: string) => api.overview(clusterId), []);
  const getResources = useCallback(
    (clusterId: string, kind: string, namespace?: string) => api.resources(clusterId, kind, namespace),
    [],
  );
  const deleteResource = useCallback(
    (clusterId: string, kind: string, row: ResourceRow) => api.deleteResource(clusterId, kind, row),
    [],
  );
  const getResourceYaml = useCallback(
    async (clusterId: string, kind: string, row: ResourceRow) => (await api.resourceYaml(clusterId, kind, row)).yaml,
    [],
  );
  const scaleDeployment = useCallback(
    (clusterId: string, namespace: string, name: string, replicas: number) =>
      api.scaleDeployment(clusterId, namespace, name, replicas),
    [],
  );
  const getPodLogs = useCallback(
    async (clusterId: string, namespace: string, name: string, container?: string) =>
      (await api.podLogs(clusterId, namespace, name, container)).logs,
    [],
  );
  const applyYaml = useCallback(
    (clusterId: string, yaml: string, namespace?: string) => api.applyYaml(clusterId, yaml, namespace),
    [],
  );

  const value = useMemo<DataContextValue>(() => ({
    clusters, loadingClusters, clusterError, refreshClusters, createCluster, updateCluster, deleteCluster,
    getOverview, getResources, deleteResource, getResourceYaml, scaleDeployment, getPodLogs, applyYaml,
  }), [clusters, loadingClusters, clusterError, refreshClusters, createCluster, updateCluster, deleteCluster,
    getOverview, getResources, deleteResource, getResourceYaml, scaleDeployment, getPodLogs, applyYaml]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const value = useContext(DataContext);
  if (!value) throw new Error('useData must be used inside DataProvider');
  return value;
}
