export interface K8sMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
}

export interface K8sResource {
  apiVersion: string;
  kind: string;
  metadata: K8sMeta;
  spec?: unknown;
  status?: unknown;
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ContainerState {
  running?: Record<string, unknown>;
  waiting?: {
    reason: string;
    message?: string;
  };
  terminated?: {
    reason: string;
    exitCode: number;
    message?: string;
  };
}

export interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state: ContainerState;
}

export interface PodStatus {
  phase: string;
  conditions: PodCondition[];
  containerStatuses: ContainerStatus[];
  restartCount: number;
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace?: string;
  };
  firstTimestamp?: string;
  lastTimestamp?: string;
  count?: number;
}
