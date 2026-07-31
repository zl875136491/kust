/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { parse, stringify } from 'yaml';
import { api } from './api';
import { demoClusters, demoLogs, demoOverview, demoResources } from './data/demo';
import type {
  Cluster,
  CreateClusterPayload,
  DataMode,
  Overview,
  ResourceListResponse,
  ResourceRow,
} from './types';

interface DataContextValue {
  mode: DataMode;
  setMode: (mode: DataMode) => void;
  clusters: Cluster[];
  loadingClusters: boolean;
  clusterError?: string;
  refreshClusters: () => Promise<void>;
  createCluster: (payload: CreateClusterPayload) => Promise<Cluster>;
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

const defaultMode = (): DataMode => {
  const cached = localStorage.getItem('kust-data-mode');
  if (cached === 'live' || cached === 'demo') return cached;
  return import.meta.env.VITE_DEMO_MODE === 'false' ? 'live' : 'demo';
};

const pluralByKind: Record<string, string> = {
  Pod: 'pods', Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets',
  ReplicaSet: 'replicasets', Job: 'jobs', CronJob: 'cronjobs', Service: 'services',
  Ingress: 'ingresses', ConfigMap: 'configmaps', Secret: 'secrets', Namespace: 'namespaces',
  NetworkPolicy: 'networkpolicies', PersistentVolumeClaim: 'persistentvolumeclaims',
};

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<DataMode>(defaultMode);
  const [clusters, setClusters] = useState<Cluster[]>(mode === 'demo' ? demoClusters : []);
  const [resources, setResources] = useState<Record<string, ResourceRow[]>>(() =>
    Object.fromEntries(Object.entries(demoResources).map(([key, value]) => [key, [...value]])),
  );
  const [loadingClusters, setLoadingClusters] = useState(mode === 'live');
  const [clusterError, setClusterError] = useState<string>();

  const refreshClusters = useCallback(async () => {
    if (mode === 'demo') {
      setLoadingClusters(false);
      setClusterError(undefined);
      return;
    }
    setLoadingClusters(true);
    try {
      setClusters(await api.clusters());
      setClusterError(undefined);
    } catch (error) {
      setClusterError(error instanceof Error ? error.message : '无法连接后端');
    } finally {
      setLoadingClusters(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'demo') {
      setClusters(demoClusters);
      setClusterError(undefined);
      setLoadingClusters(false);
    } else {
      void refreshClusters();
    }
  }, [mode, refreshClusters]);

  const setMode = useCallback((nextMode: DataMode) => {
    localStorage.setItem('kust-data-mode', nextMode);
    setModeState(nextMode);
  }, []);

  const createCluster = useCallback(async (payload: CreateClusterPayload) => {
    if (mode === 'live') {
      const cluster = await api.createCluster(payload);
      setClusters((current) => [...current, cluster]);
      return cluster;
    }
    const cluster: Cluster = {
      id: `demo-${Date.now()}`,
      name: payload.name,
      description: payload.description || '本地演示集群',
      context: payload.context || payload.name,
      server: 'https://demo.cluster.local:6443',
      kubernetesVersion: 'v1.31.4',
      status: 'connected',
      createdAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      warnings: 0,
      accent: '#4b7fbd',
    };
    setClusters((current) => [...current, cluster]);
    return cluster;
  }, [mode]);

  const deleteCluster = useCallback(async (clusterId: string) => {
    if (mode === 'live') await api.deleteCluster(clusterId);
    setClusters((current) => current.filter((cluster) => cluster.id !== clusterId));
  }, [mode]);

  const getOverview = useCallback(async (clusterId: string) => {
    if (mode === 'live') return api.overview(clusterId);
    return structuredClone(demoOverview);
  }, [mode]);

  const getResources = useCallback(async (clusterId: string, kind: string, namespace?: string) => {
    if (mode === 'live') return api.resources(clusterId, kind, namespace);
    const items = (resources[kind] || []).filter(
      (item) => !namespace || namespace === 'all' || item.namespace === namespace,
    );
    return { kind: items[0]?.kind || kind, items: structuredClone(items) };
  }, [mode, resources]);

  const deleteResource = useCallback(async (clusterId: string, kind: string, row: ResourceRow) => {
    if (mode === 'live') await api.deleteResource(clusterId, kind, row);
    setResources((current) => ({
      ...current,
      [kind]: (current[kind] || []).filter((item) => item.uid !== row.uid),
    }));
  }, [mode]);

  const getResourceYaml = useCallback(async (clusterId: string, kind: string, row: ResourceRow) => {
    if (mode === 'live') return (await api.resourceYaml(clusterId, kind, row)).yaml;
    return stringify({
      apiVersion: ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(row.kind) ? 'apps/v1' : 'v1',
      kind: row.kind,
      metadata: { name: row.name, ...(row.namespace ? { namespace: row.namespace } : {}), labels: row.labels },
      ...(row.kind === 'Deployment' ? { spec: { replicas: Number(row.ready?.split('/')[1] || 1) } } : {}),
    });
  }, [mode]);

  const scaleDeployment = useCallback(async (clusterId: string, namespace: string, name: string, replicas: number) => {
    if (mode === 'live') return api.scaleDeployment(clusterId, namespace, name, replicas);
    let result: ResourceRow | undefined;
    setResources((current) => ({
      ...current,
      deployments: current.deployments.map((item) => {
        if (item.name !== name || item.namespace !== namespace) return item;
        result = { ...item, ready: `${replicas}/${replicas}`, status: 'Ready', details: { ...item.details, desired: replicas, available: replicas } };
        return result;
      }),
    }));
    return result || resources.deployments.find((item) => item.name === name)!;
  }, [mode, resources.deployments]);

  const getPodLogs = useCallback(async (clusterId: string, namespace: string, name: string, container?: string) => {
    if (mode === 'live') return (await api.podLogs(clusterId, namespace, name, container)).logs;
    return demoLogs;
  }, [mode]);

  const applyYaml = useCallback(async (clusterId: string, yaml: string, namespace?: string) => {
    if (mode === 'live') return api.applyYaml(clusterId, yaml, namespace);
    const document = parse(yaml) as { kind?: string; metadata?: { name?: string; namespace?: string } };
    const kind = document?.kind || 'Resource';
    const name = document?.metadata?.name;
    if (!name) throw new Error('metadata.name 不能为空');
    const resourceNamespace = document.metadata?.namespace || namespace;
    const key = pluralByKind[kind];
    if (key) {
      const item: ResourceRow = {
        uid: `${kind.toLowerCase()}-${resourceNamespace || 'cluster'}-${name}`,
        name,
        namespace: resourceNamespace,
        kind,
        status: 'Active',
        createdAt: new Date().toISOString(),
        labels: {},
        details: {},
      };
      setResources((current) => ({ ...current, [key]: [item, ...(current[key] || []).filter((existing) => existing.uid !== item.uid)] }));
    }
    return { kind, name, namespace: resourceNamespace };
  }, [mode]);

  const value = useMemo<DataContextValue>(() => ({
    mode, setMode, clusters, loadingClusters, clusterError, refreshClusters, createCluster,
    deleteCluster, getOverview, getResources, deleteResource, getResourceYaml, scaleDeployment, getPodLogs,
    applyYaml,
  }), [mode, setMode, clusters, loadingClusters, clusterError, refreshClusters, createCluster,
    deleteCluster, getOverview, getResources, deleteResource, getResourceYaml, scaleDeployment, getPodLogs,
    applyYaml]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const value = useContext(DataContext);
  if (!value) throw new Error('useData must be used inside DataProvider');
  return value;
}
